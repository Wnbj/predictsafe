import {
  MarketStatus,
  Outcome,
  type LpEvent,
  type LpPosition,
  type Market,
  type TradeEvent,
  isAmm,
} from "./types";

/**
 * Valuing a liquidity position.
 *
 * WHY THERE IS NO DIVERGENCE TERM HERE. In a spot AMM, impermanent loss is
 * measured against holding the two assets, and that benchmark moves. In a
 * binary market built from complete sets it does not: `d` collateral mints `d`
 * YES and `d` NO, which pay exactly `d` at settlement whichever side wins, and
 * `d` again on a void where each side is halved. Holding is worth `d`. Not
 * providing at all is worth `d`. So par IS the benchmark, and the provider's
 * entire result is `value - deposited`, which splits cleanly into what the
 * fees brought in and what the traders took out.
 */

/**
 * A provider's slice of the pool while the market is still open.
 *
 * The pool holds `yesReserve` YES and `noReserve` NO. At the marginal price
 * `p = noReserve / (yes + no)` those are worth `p·Y + (1-p)·N`, which reduces
 * to the HARMONIC MEAN of the reserves, `2YN/(Y+N)`. That is not a rounding
 * artefact — it is the structural cost of quoting: a balanced pool marks at
 * its own depth, while a skewed one marks strictly below it, because the side
 * the market has moved away from is the side the pool is left holding.
 *
 * It is a mark, not a claim. Nothing is owed until settlement.
 */
export function markPoolValue(m: Market, shares: bigint, totalShares: bigint): bigint {
  if (!isAmm(m) || totalShares === 0n || shares === 0n) return 0n;

  const y = m.yesReserve;
  const n = m.noReserve;
  if (y + n === 0n) return 0n;

  const poolValue = (2n * y * n) / (y + n);
  return (poolValue * shares) / totalShares;
}

/**
 * Fees earned by each provider, attributed by an ordered replay.
 *
 * A provider earns only from the trades that happened WHILE they were
 * providing. The tempting shortcut — take the market's lifetime fees and split
 * them by today's shares — pays a late arrival for volume that traded before
 * they existed, which is exactly the property the contract goes out of its way
 * not to grant: fees inflate the reserves without minting shares, so a later
 * deposit buys proportionally fewer of them.
 *
 * Both event streams must therefore be walked together in block order, which
 * is why `LiquidityAdded` carries the running share total and `Bought`/`Sold`
 * carry the fee.
 *
 * @returns fees earned, keyed `marketKey` → provider → amount.
 */
export function attributeFees(
  lpEvents: LpEvent[],
  trades: TradeEvent[],
): Map<string, Map<string, bigint>> {
  const merged = [...lpEvents.map((e) => ({ block: e.blockNumber, lp: e, trade: null as TradeEvent | null })),
    ...trades
      .filter((t) => t.amm)
      .map((t) => ({ block: t.blockNumber, lp: null as LpEvent | null, trade: t }))]
    .sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));

  const earned = new Map<string, Map<string, bigint>>();
  // Live share ledger per market, rebuilt as the replay walks forward.
  const ledger = new Map<string, { total: bigint; byProvider: Map<string, bigint> }>();

  const bookFor = (key: string) => {
    let b = ledger.get(key);
    if (!b) {
      b = { total: 0n, byProvider: new Map() };
      ledger.set(key, b);
    }
    return b;
  };

  for (const entry of merged) {
    if (entry.lp) {
      const e = entry.lp;
      const book = bookFor(e.marketKey);
      const who = e.provider.toLowerCase();
      if (e.direction === "add") {
        book.byProvider.set(who, (book.byProvider.get(who) ?? 0n) + e.lpShares);
        book.total += e.lpShares;
      }
      // A withdrawal does not burn shares on chain — it flips a one-shot flag
      // after settlement, by which point no further fees can accrue. Leaving
      // the ledger untouched keeps the denominator matching the contract's.
      continue;
    }

    const t = entry.trade!;
    if (!t.amm || t.amm.fee === 0n) continue;
    const book = ledger.get(t.marketKey);
    if (!book || book.total === 0n) continue;

    let perMarket = earned.get(t.marketKey);
    if (!perMarket) {
      perMarket = new Map();
      earned.set(t.marketKey, perMarket);
    }
    for (const [who, shares] of book.byProvider) {
      const cut = (t.amm.fee * shares) / book.total;
      if (cut === 0n) continue;
      perMarket.set(who, (perMarket.get(who) ?? 0n) + cut);
    }
  }

  return earned;
}

/**
 * Build one wallet's liquidity position for a market, or null if they never
 * provided to it.
 *
 * `poolValue` prefers the chain's own `claimable` once the market has settled,
 * and falls back to the mark above while it is open — the same discipline the
 * trading side follows in quoting rather than recomputing.
 */
export function buildLpPosition(
  m: Market,
  chainPosition: { shares: bigint; totalShares: bigint; withdrawn: boolean; claimable: bigint } | undefined,
  deposited: bigint,
  feesEarned: bigint,
  residual: { yes: bigint; no: bigint } = { yes: 0n, no: 0n },
): LpPosition | null {
  if (!chainPosition || chainPosition.shares === 0n) return null;

  const resolved = m.status === MarketStatus.Settled || m.status === MarketStatus.Void;
  return {
    shares: chainPosition.shares,
    totalShares: chainPosition.totalShares,
    deposited,
    feesEarned,
    poolValue: resolved
      ? chainPosition.claimable
      : markPoolValue(m, chainPosition.shares, chainPosition.totalShares),
    withdrawn: chainPosition.withdrawn,
    marked: !resolved,
    residualYes: residual.yes,
    residualNo: residual.no,
  };
}

/**
 * What the shares a provider's deposits handed back are worth: marked at the
 * price while the market is open, at what `redeem` pays once it is resolved.
 *
 * Capped at what the wallet still holds — residual shares can be sold or
 * redeemed like any others, and what is gone is no longer the provider's.
 * Only the RESIDUAL is valued here; shares bought by trading are a separate
 * position and belong in the trading P&L, not the liquidity one.
 */
export function residualValue(m: Market, lp: LpPosition, heldYes: bigint, heldNo: bigint): bigint {
  if (!isAmm(m)) return 0n;
  const yes = lp.residualYes < heldYes ? lp.residualYes : heldYes;
  const no = lp.residualNo < heldNo ? lp.residualNo : heldNo;
  const resolved = m.status === MarketStatus.Settled || m.status === MarketStatus.Void;
  if (!resolved) return markShares(m, yes, no);
  if (m.status === MarketStatus.Void || m.outcome === Outcome.Void) return (yes + no) / 2n;
  return m.outcome === Outcome.Yes ? yes : m.outcome === Outcome.No ? no : 0n;
}

/** The shares each of this wallet's deposits left with it, summed per market. */
export function residualsByMarket(
  lpEvents: LpEvent[],
  account: string | null,
): Map<string, { yes: bigint; no: bigint }> {
  const out = new Map<string, { yes: bigint; no: bigint }>();
  if (!account) return out;
  const me = account.toLowerCase();
  for (const e of lpEvents) {
    if (e.direction !== "add" || e.provider.toLowerCase() !== me) continue;
    const r = out.get(e.marketKey) ?? { yes: 0n, no: 0n };
    out.set(e.marketKey, { yes: r.yes + (e.yesResidual ?? 0n), no: r.no + (e.noResidual ?? 0n) });
  }
  return out;
}

/**
 * What a provider's residual shares are worth, marked at the current price
 * while the market is open.
 *
 * The shares a deposit hands back are ordinary shares and are already valued
 * by `claimablePayout` once a market resolves. Before that they need a mark,
 * and the honest one is the same price the book is quoting.
 */
export function markShares(m: Market, yes: bigint, no: bigint): bigint {
  if (!isAmm(m)) return 0n;
  const p = BigInt(m.yesPriceBps);
  return (yes * p + no * (10_000n - p)) / 10_000n;
}

/**
 * The three numbers a provider actually wants, given a built position.
 *
 * `impermanentLoss` is the standard meaning — how far the position fell short
 * of simply holding, BEFORE fees. Reporting only the net would collapse two
 * different stories into one number: a pool that earned its keep while the
 * traders were right looks identical to one that did neither.
 */
export function lpPnl(
  lp: LpPosition,
  residualValue: bigint,
): { value: bigint; pnl: bigint; impermanentLoss: bigint } {
  const value = lp.poolValue + residualValue;
  const pnl = value - lp.deposited;
  return { value, pnl, impermanentLoss: lp.feesEarned - pnl };
}

/** Total collateral this wallet has deposited into each market. */
export function depositsByMarket(
  lpEvents: LpEvent[],
  account: string | null,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!account) return out;
  const me = account.toLowerCase();

  for (const e of lpEvents) {
    if (e.direction !== "add") continue;
    if (e.provider.toLowerCase() !== me) continue;
    out.set(e.marketKey, (out.get(e.marketKey) ?? 0n) + e.amount);
  }
  return out;
}
