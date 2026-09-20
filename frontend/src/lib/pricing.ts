import { MarketStatus, Outcome, type Market, type Side } from "./types";

/**
 * What a market is worth, across BOTH pricing models.
 *
 * This was `parimutuel.ts` and mirrored FlightMarket.sol alone. It now serves
 * the AMM too, and the rename is not cosmetic: almost every function here has
 * a branch where the two models disagree, and reading the file as
 * parimutuel-only is how you talk yourself into applying the wrong one.
 *
 * The disagreement that matters most: **a parimutuel percentage and an AMM
 * percentage are different things.** In a parimutuel pool your payout is your
 * fraction of the winning side times the whole pot, fixed only at settlement,
 * so a percentage is a current implied probability that moves whenever anyone
 * else stakes — never a price you bought at. In the AMM it IS the price a
 * small trade executes at, and it is read from the quoted price rather than
 * from the reserves, which run the opposite way.
 *
 * All arithmetic uses bigint with truncating division so displayed figures
 * match what the contract actually transfers, down to the last unit.
 */

/**
 * Current implied probability of Yes, 0–100. Null when nothing is staked yet.
 *
 * An AMM market is read from its quoted price, NOT from its reserves. In a
 * constant-product pool the price of YES is the *opposite* reserve over the
 * total — the scarcer YES is, the dearer it is — so applying the parimutuel
 * ratio to those numbers reports the odds exactly inverted.
 */
export function impliedYesPercent(m: Market): number | null {
  if (m.categoryId === "amm") return m.yesPriceBps / 100;
  const total = m.yesPool + m.noPool;
  if (total === 0n) return null;
  return Number((m.yesPool * 10000n) / total) / 100;
}

/**
 * The money actually at stake.
 *
 * For an AMM that is the collateral, not the sum of the reserves: one unit of
 * collateral mints one YES *and* one NO, so adding the two reserves counts the
 * same money twice.
 */
export function totalPool(m: Market): bigint {
  if (m.categoryId === "amm") return m.collateral;
  return m.yesPool + m.noPool;
}

/**
 * A market that resolved without anyone ever staking on it.
 *
 * Every one of these on this deployment is a rehearsal: a flight replayed to
 * check the provider, a backtest against a feed round, a market created purely
 * to see whether a handler fires. They are real history and they stay on
 * chain — `/live` shows every settlement whatever the stakes — but on a board
 * whose job is to show what people are betting on, twenty cards reading
 * "Void · No stakes yet · 0 mUSDC" describe the testing, not the product.
 *
 * The discriminator is deliberately economic rather than a list of ids: a
 * market nobody staked into cost nobody anything and paid nobody, so it has no
 * story a reader of this page is looking for. It must be RESOLVED as well —
 * an open market with no stakes yet is not a rehearsal, it is an invitation,
 * and hiding it would hide the one thing a visitor can act on.
 */
export function isUnstakedAndResolved(m: Market): boolean {
  const resolved = m.status === MarketStatus.Settled || m.status === MarketStatus.Void;
  return resolved && totalPool(m) === 0n;
}

/**
 * A one-sided book cannot pay out — FlightMarket voids it at settlement
 * regardless of the outcome the DON agrees on. Worth surfacing in the UI
 * before someone stakes into a market that can only refund.
 */
export function isOneSided(m: Market): boolean {
  // An AMM market has no such failure: every share is individually
  // collateralised, so it settles correctly even with no trades at all.
  if (m.categoryId === "amm") return false;
  const total = m.yesPool + m.noPool;
  return total > 0n && (m.yesPool === 0n || m.noPool === 0n);
}

export function isOpenForStaking(m: Market, nowSeconds: number): boolean {
  return m.status === MarketStatus.Open && nowSeconds < m.closeTime;
}

export function canRequestSettlement(m: Market, nowSeconds: number): boolean {
  return (
    (m.status === MarketStatus.Open || m.status === MarketStatus.Locked) &&
    nowSeconds >= m.settleAfter
  );
}

export interface PayoutEstimate {
  /** Gross tokens returned if this side wins. */
  payout: bigint;
  /** payout - stake. Negative is impossible here (payout >= stake when you win). */
  profit: bigint;
  /**
   * True when the stake would leave the book one-sided, meaning the only
   * possible result is a refund rather than a win.
   */
  refundOnly: boolean;
}

/**
 * What staking `amount` on `side` would return **if that side wins**, given the
 * pools as they stand right now. Other stakes landing afterwards will change it.
 */
export function estimatePayout(
  m: Market,
  side: Side,
  amount: bigint,
): PayoutEstimate | null {
  if (amount <= 0n) return null;
  /**
   * An AMM has no pot to divide and cannot void for a one-sided book — every
   * share is individually collateralised. Running the parimutuel formula over
   * its reserves would eventually claim "this market would refund", which is
   * simply false. The AMM quotes from the contract instead; there is nothing
   * to estimate here.
   */
  if (m.categoryId === "amm") return null;

  const yesPool = side === "yes" ? m.yesPool + amount : m.yesPool;
  const noPool = side === "no" ? m.noPool + amount : m.noPool;
  const total = yesPool + noPool;
  const winningPool = side === "yes" ? yesPool : noPool;
  const losingPool = side === "yes" ? noPool : yesPool;

  // Contract voids a one-sided book: everyone is refunded their own stake.
  if (losingPool === 0n) {
    return { payout: amount, profit: 0n, refundOnly: true };
  }

  const payout = (amount * total) / winningPool;
  return { payout, profit: payout - amount, refundOnly: false };
}

/**
 * Exactly what `claim()` would transfer to a holder of these stakes.
 * Mirrors FlightMarket.claim, including its truncating division.
 */
export function claimablePayout(
  m: Market,
  yesStake: bigint,
  noStake: bigint,
): bigint {
  // AMM shares are worth one unit each if they win — no proportional split,
  // because each was collateralised individually when it was minted. A void
  // pays half a unit per share either side, which is the only division that
  // stays solvent when one unit of collateral backs one share of each side.
  if (m.categoryId === "amm") {
    if (m.status === MarketStatus.Void) return (yesStake + noStake) / 2n;
    if (m.status !== MarketStatus.Settled) return 0n;
    if (m.outcome === Outcome.Yes) return yesStake;
    if (m.outcome === Outcome.No) return noStake;
    return 0n;
  }

  if (m.status === MarketStatus.Void) {
    return yesStake + noStake;
  }
  if (m.status !== MarketStatus.Settled) {
    return 0n;
  }
  const total = m.yesPool + m.noPool;
  if (m.outcome === Outcome.Yes) {
    if (m.yesPool === 0n) return 0n;
    return (yesStake * total) / m.yesPool;
  }
  if (m.outcome === Outcome.No) {
    if (m.noPool === 0n) return 0n;
    return (noStake * total) / m.noPool;
  }
  return 0n;
}
