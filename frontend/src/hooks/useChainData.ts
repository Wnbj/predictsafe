import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import {
  readAllowance,
  readLpEvents,
  readMarkets,
  readSettledEvents,
  readTradeEvents,
  readTokenBalance,
  readWalletLp,
  readWalletStakes,
} from "../lib/chain";
import { claimablePayout } from "../lib/pricing";
import { loadCachedMarkets, saveMarkets } from "../lib/marketCache";
import { attributeFees, buildLpPosition, depositsByMarket } from "../lib/lp";
import {
  MarketStatus,
  Outcome,
  type LpEvent,
  type Market,
  type Position,
  type SettledEvent,
  type TradeEvent,
  type TraderStats,
} from "../lib/types";

export interface ChainData {
  markets: Market[];
  tradeEvents: TradeEvent[];
  settledEvents: SettledEvent[];
  lpEvents: LpEvent[];
  positions: Position[];
  balance: bigint;
  /** Keyed by spender (market contract) — ERC-20 allowance is per spender. */
  allowances: Map<string, bigint>;
  /** True until the markets have been read once. Never set back afterwards. */
  loading: boolean;
  /**
   * True while event history and the wallet's positions are still arriving —
   * on first load, and again when the account changes. Pages that would
   * otherwise state "nothing here" (portfolio, leaderboard) wait on it; the
   * rest render as soon as `loading` clears.
   */
  enriching: boolean;
  /** Showing the previous visit's markets while this visit's read runs. */
  stale: boolean;
  error: string | null;
  /**
   * Categories whose contract could not be read, named rather than merged into
   * `error` — a category missing from the list looks identical to a category
   * with no markets in it, so it has to be said out loud.
   */
  failedCategories: { categoryId: string; message: string }[];
  /** Markets loaded but event history did not — charts and leaderboard are thin. */
  historyDegraded: boolean;
  refresh: () => Promise<void>;
}

export function derivePositions(
  markets: Market[],
  stakes: Map<string, { yes: bigint; no: bigint; claimed: boolean }>,
  /**
   * Trades by this wallet, needed only to price AMM positions: the contract
   * records the shares you hold, not what you paid for them, and a sale
   * returns collateral without leaving a trace in the balance.
   */
  trades: TradeEvent[] = [],
  account: Address | null = null,
  /**
   * Liquidity movements. Needed because providing liquidity emits no trade:
   * without it a provider's position prices at zero and reports as pure profit.
   */
  lpEvents: LpEvent[] = [],
  /** This wallet's LP stake per market, read from chain. */
  lpStakes: Map<
    string,
    { shares: bigint; totalShares: bigint; withdrawn: boolean; claimable: bigint }
  > = new Map(),
): Position[] {
  const netInByMarket = new Map<string, bigint>();
  for (const e of trades) {
    if (!e.amm) continue;
    if (account && e.user.toLowerCase() !== account.toLowerCase()) continue;
    const sign = e.amm.direction === "buy" ? 1n : -1n;
    netInByMarket.set(e.marketKey, (netInByMarket.get(e.marketKey) ?? 0n) + sign * e.amount);
  }

  const deposits = depositsByMarket(lpEvents, account);
  const fees = attributeFees(lpEvents, trades);

  const out: Position[] = [];
  markets.forEach((m) => {
    const s = stakes.get(m.key) ?? { yes: 0n, no: 0n, claimed: false };
    const lpStake = lpStakes.get(m.key);

    /**
     * A provider in a pool at even money holds NO residual shares at all —
     * the reserves take the whole deposit — so a position with liquidity in it
     * is not necessarily a position with shares in it. Skipping on shares
     * alone made their whole stake vanish from the portfolio.
     */
    if (s.yes === 0n && s.no === 0n && !lpStake) return;

    let entitlement = claimablePayout(m, s.yes, s.no);
    // Kept before the pool claim is added below — this is what `redeem()`
    // alone would pay, and the only honest label for the button that calls it.
    const shareEntitlement = entitlement;
    let cost = m.categoryId === "amm" ? (netInByMarket.get(m.key) ?? 0n) : s.yes + s.no;

    /**
     * Liquidity is money at risk in a second way, on top of any shares the
     * deposit left behind: a pro-rata claim on whatever of the winning side
     * the pool still holds. Counting only the shares would show a provider
     * hugely up when the market opened away from even money; counting only the
     * pool would miss the position their own price implied.
     */
    const lp = lpStake
      ? buildLpPosition(
          m,
          lpStake,
          deposits.get(m.key) ?? 0n,
          fees.get(m.key)?.get(account?.toLowerCase() ?? "") ?? 0n,
        )
      : null;

    /**
     * The two claims are guarded SEPARATELY on chain — `redeemed` covers the
     * shares, `lpWithdrawn` covers the pool — so what is still claimable has to
     * be summed from two independent questions. Gating both on `claimed` would
     * hide a pool claim the moment the shares were redeemed, and the flags are
     * irreversible, so the money would simply stay there.
     */
    let claimable = s.claimed ? 0n : entitlement;
    if (lp) {
      cost += lp.deposited;
      entitlement += lp.poolValue;
      if (!lp.withdrawn && !lp.marked) claimable += lp.poolValue;
    }

    let status: Position["status"];
    const fullyClaimed = s.claimed && (!lp || lp.withdrawn);
    if (fullyClaimed) status = "Claimed";
    else if (m.status === MarketStatus.Void) status = "Refundable";
    else if (m.status === MarketStatus.Settled) {
      status = entitlement > 0n ? "Won" : "Lost";
    } else if (m.status === MarketStatus.SettlementRequested) {
      status = "Awaiting settlement";
    } else status = "Open";

    out.push({
      market: m,
      yes: s.yes,
      no: s.no,
      claimed: s.claimed,
      claimable,
      entitlement,
      shareClaimable: s.claimed ? 0n : shareEntitlement,
      shareEntitlement,
      cost,
      status,
      ...(lp ? { lp } : {}),
    });
  });
  return out;
}

/**
 * Leaderboard built from real Staked events plus settled outcomes — no invented
 * traders. With a handful of test wallets this is necessarily sparse; that is a
 * truthful reflection of the chain rather than a gap to be padded.
 */
export function deriveTraders(
  markets: Market[],
  stakes: TradeEvent[],
  /**
   * Liquidity movements. Without them a provider who never traded does not
   * appear on the leaderboard at all, however much they put at risk — and
   * providing liquidity is the position with the least visible risk of any
   * here, so leaving it out flatters exactly the wrong people.
   */
  lpEvents: LpEvent[] = [],
): TraderStats[] {
  /**
   * Per market, per trader: the position held and the money that changed
   * hands.
   *
   * Parimutuel and AMM cannot share one accumulator. In a parimutuel market
   * your stake IS your position, so one number does both jobs. In an AMM they
   * are different quantities in different units — collateral spent versus
   * shares held — and a sell moves them in opposite directions: the position
   * shrinks while cash comes back. Adding a sell to "staked" would report
   * someone who bought and sold as having risked twice as much as they did.
   */
  type Book = {
    /** Shares held (AMM) or collateral staked (parimutuel), per side. */
    yes: bigint;
    no: bigint;
    /** Net collateral put in: buys and stakes less anything sold back. */
    netIn: bigint;
    isAmm: boolean;
    /** LP shares held in this market, and what they cost. */
    lpShares: bigint;
    lpDeposited: bigint;
  };

  const byUser = new Map<Address, { staked: bigint; perMarket: Map<string, Book> }>();

  const recFor = (user: Address) => {
    let rec = byUser.get(user);
    if (!rec) {
      rec = { staked: 0n, perMarket: new Map() };
      byUser.set(user, rec);
    }
    return rec;
  };
  const bookFor = (rec: { perMarket: Map<string, Book> }, key: string, isAmm: boolean) => {
    let book = rec.perMarket.get(key);
    if (!book) {
      book = { yes: 0n, no: 0n, netIn: 0n, isAmm, lpShares: 0n, lpDeposited: 0n };
      rec.perMarket.set(key, book);
    }
    return book;
  };

  for (const e of lpEvents) {
    if (e.direction !== "add") continue;
    const rec = recFor(e.provider);
    const book = bookFor(rec, e.marketKey, true);
    book.lpShares += e.lpShares;
    book.lpDeposited += e.amount;
    rec.staked += e.amount;
  }

  for (const e of stakes) {
    const rec = recFor(e.user);
    const book = bookFor(rec, e.marketKey, e.amm !== undefined);

    if (e.amm) {
      const sign = e.amm.direction === "buy" ? 1n : -1n;
      if (e.isYes) book.yes += sign * e.amm.shares;
      else book.no += sign * e.amm.shares;
      book.netIn += sign * e.amount;
      // Capital at risk is what is still in, so a sale returns it.
      rec.staked += sign * e.amount;
    } else {
      if (e.isYes) book.yes += e.amount;
      else book.no += e.amount;
      book.netIn += e.amount;
      rec.staked += e.amount;
    }
  }

  // Keyed by composite key, not id: flight 0 and crypto 0 are different
  // markets and must not collapse into one another here.
  const marketByKey = new Map(markets.map((m) => [m.key, m]));
  const out: TraderStats[] = [];

  for (const [address, rec] of byUser) {
    let profit = 0n;
    let wins = 0;
    let settledMarkets = 0;

    for (const [key, book] of rec.perMarket) {
      const m = marketByKey.get(key);
      if (!m) continue;
      const isResolved = m.status === MarketStatus.Settled || m.status === MarketStatus.Void;
      if (!isResolved) continue;

      settledMarkets += 1;
      // Profit is redemption value less net cash in — which for an AMM already
      // nets off anything sold back before expiry, so a position closed early
      // scores its realised result rather than nothing.
      let payout = claimablePayout(m, book.yes, book.no);
      let cost = book.netIn;

      // A provider's pool claim is the other half of what they are owed, and
      // its cost is what they deposited. Both sides have to be added, or
      // liquidity would score as pure profit or pure loss.
      if (book.lpShares > 0n && m.categoryId === "amm" && m.totalLpShares > 0n) {
        const winning =
          m.status === MarketStatus.Void
            ? (m.yesReserve + m.noReserve) / 2n
            : m.outcome === Outcome.Yes
              ? m.yesReserve
              : m.noReserve;
        payout += (winning * book.lpShares) / m.totalLpShares;
        cost += book.lpDeposited;
      }

      profit += payout - cost;
      // A void refunds rather than resolving, so it counts as neither win nor loss.
      if (m.status === MarketStatus.Settled && payout > cost) wins += 1;
    }

    out.push({ address, staked: rec.staked, settledMarkets, wins, profit });
  }

  return out.sort((a, b) => (b.profit === a.profit ? 0 : b.profit > a.profit ? 1 : -1));
}

export function useChainData(account: Address | null): ChainData {
  // Last visit's markets, if any, so a returning visitor sees the board at
  // once; `stale` stays true until this visit's own read replaces them.
  const [cached] = useState(() => loadCachedMarkets());
  const [markets, setMarkets] = useState<Market[]>(cached?.markets ?? []);
  const [stale, setStale] = useState(cached !== null);
  const [tradeEvents, setTradeEvents] = useState<TradeEvent[]>([]);
  const [settledEvents, setSettledEvents] = useState<SettledEvent[]>([]);
  const [lpEvents, setLpEvents] = useState<LpEvent[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [balance, setBalance] = useState<bigint>(0n);
  /** Keyed by spender (market contract) — ERC-20 allowance is per spender. */
  const [allowances, setAllowances] = useState<Map<string, bigint>>(new Map());
  const [loading, setLoading] = useState(cached === null);
  const [enriching, setEnriching] = useState(true);
  const [failedCategories, setFailedCategories] = useState<
    { categoryId: string; message: string }[]
  >([]);
  const [historyDegraded, setHistoryDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      /*
       * Markets are the page; event history only enriches it (sparklines,
       * activity, leaderboard). Public RPCs fail getLogs often enough that
       * tying the two together would blank the whole app over a flaky log
       * query, so events are allowed to fail on their own.
       */
      const { markets: ms, failed } = await readMarkets();
      setMarkets(ms);
      setFailedCategories(failed);
      setStale(false);
      // Only a complete read is worth handing to the next visit.
      if (failed.length === 0) saveMarkets(ms);
      // The markets ARE the page. History and positions fill in behind them;
      // gating on all of it kept "Loading markets" up for the whole log scan.
      setLoading(false);

      const [se, sv, lp] = await Promise.all([
        readTradeEvents().catch(() => null),
        readSettledEvents().catch(() => null),
        readLpEvents().catch(() => [] as LpEvent[]),
      ]);
      if (se) setTradeEvents(se);
      if (sv) setSettledEvents(sv);
      setLpEvents(lp);
      setHistoryDegraded(se === null || sv === null);

      if (account) {
        // Allowance is per spender, so each market contract needs its own.
        const spenders = [...new Set(ms.map((m) => m.contract))];
        const [stakes, lpStakes, bal, allows] = await Promise.all([
          readWalletStakes(account, ms),
          readWalletLp(ms, account),
          readTokenBalance(account),
          Promise.all(spenders.map((s) => readAllowance(account, s))),
        ]);
        setPositions(derivePositions(ms, stakes, se ?? [], account, lp, lpStakes));
        setBalance(bal);
        setAllowances(new Map(spenders.map((s, i) => [s, allows[i]!])));
      } else {
        setPositions([]);
        setBalance(0n);
        setAllowances(new Map());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load chain data");
    } finally {
      setLoading(false);
      setEnriching(false);
    }
  }, [account]);

  // Not `setLoading(true)`: connecting a wallet used to blank every page back
  // to "Loading markets" while markets that had not changed were read again.
  useEffect(() => {
    setEnriching(true);
    void refresh();
  }, [refresh]);

  return {
    markets,
    tradeEvents,
    settledEvents,
    lpEvents,
    positions,
    balance,
    allowances,
    loading,
    enriching,
    stale,
    error,
    failedCategories,
    historyDegraded,
    refresh,
  };
}
