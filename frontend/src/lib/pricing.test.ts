import { describe, expect, it } from "vitest";
import {
  claimablePayout,
  estimatePayout,
  impliedYesPercent,
  isOneSided,
  totalPool,
  isUnstakedAndResolved,
} from "./pricing";
import { MarketStatus, Outcome, type Market } from "./types";
import { amm0, crypto0 } from "./fixtures";

/**
 * The payout maths the UI shows before anyone signs anything.
 *
 * `claimablePayout` mirrors the contract's `claim()`, truncating division and
 * all. If it drifts from the contract, the app promises a number the chain
 * will not pay — so the tests below are written against the contract's rules,
 * not against the function's current behaviour.
 */

const market = (over: Partial<Market>): Market => ({ ...crypto0, ...over }) as Market;

const settled = (outcome: Outcome, yesPool: bigint, noPool: bigint) =>
  market({ status: MarketStatus.Settled, outcome, yesPool, noPool });

describe("claimablePayout", () => {
  it("pays the winning side its share of the whole pot", () => {
    // Yes pool 1, No pool 3, pot 4. A sole Yes staker takes everything.
    expect(claimablePayout(settled(Outcome.Yes, 1_000_000n, 3_000_000n), 1_000_000n, 0n)).toBe(
      4_000_000n,
    );
  });

  it("pays a loser nothing, whatever they staked", () => {
    expect(claimablePayout(settled(Outcome.No, 1_000_000n, 3_000_000n), 1_000_000n, 0n)).toBe(0n);
  });

  it("splits proportionally between winners on the same side", () => {
    const m = settled(Outcome.Yes, 4_000_000n, 4_000_000n);
    const a = claimablePayout(m, 1_000_000n, 0n);
    const b = claimablePayout(m, 3_000_000n, 0n);
    expect(a).toBe(2_000_000n);
    expect(b).toBe(6_000_000n);
    expect(a + b).toBe(totalPool(m));
  });

  it("refunds both sides on a void, regardless of outcome", () => {
    const m = market({ status: MarketStatus.Void, outcome: Outcome.Yes });
    expect(claimablePayout(m, 700_000n, 300_000n)).toBe(1_000_000n);
  });

  it("pays nothing while the market is unresolved", () => {
    for (const status of [
      MarketStatus.Open,
      MarketStatus.Locked,
      MarketStatus.SettlementRequested,
    ]) {
      expect(claimablePayout(market({ status }), 1_000_000n, 0n)).toBe(0n);
    }
  });

  /**
   * A settled market whose winning pool is empty would divide by zero on
   * chain, so the contract cannot reach that state — but the UI reads chain
   * data it does not control and must not crash on it.
   */
  it("returns zero rather than dividing by an empty winning pool", () => {
    expect(claimablePayout(settled(Outcome.Yes, 0n, 3_000_000n), 0n, 1_000_000n)).toBe(0n);
    expect(claimablePayout(settled(Outcome.No, 3_000_000n, 0n), 1_000_000n, 0n)).toBe(0n);
  });

  /**
   * Solvency: the contract can only ever pay out what it holds. Truncating
   * division must always round in the pot's favour, never against it.
   */
  it("never pays out more than the pot, across awkward splits", () => {
    for (const yesPool of [1n, 7n, 999_999n, 1_000_001n, 3_333_333n]) {
      for (const noPool of [1n, 13n, 1_000_000n, 7_777_777n]) {
        const m = settled(Outcome.Yes, yesPool, noPool);
        // One winner holding the entire winning pool is the largest single claim.
        expect(claimablePayout(m, yesPool, 0n)).toBeLessThanOrEqual(yesPool + noPool);
      }
    }
  });

  it("splits three uneven winners without exceeding the pot", () => {
    const m = settled(Outcome.Yes, 1_000_003n, 5_000_000n);
    const stakes = [333_334n, 333_334n, 333_335n];
    const paid = stakes.reduce((sum, s) => sum + claimablePayout(m, s, 0n), 0n);
    expect(paid).toBeLessThanOrEqual(totalPool(m));
  });
});

describe("estimatePayout", () => {
  it("accounts for the stake being added to its own side", () => {
    // Staking 1 on Yes with pools 1/2 makes it 2/2: pot 4, half the Yes pool.
    const e = estimatePayout(market({ yesPool: 1_000_000n, noPool: 2_000_000n }), "yes", 1_000_000n);
    expect(e?.payout).toBe(2_000_000n);
    expect(e?.profit).toBe(1_000_000n);
  });

  /**
   * Staking into an empty book cannot win — the contract voids a one-sided
   * market — so promising a multiple would be a lie the chain refuses to pay.
   */
  it("reports refund-only when the other side is empty", () => {
    const e = estimatePayout(market({ yesPool: 0n, noPool: 0n }), "yes", 1_000_000n);
    expect(e).toEqual({ payout: 1_000_000n, profit: 0n, refundOnly: true });
  });

  it("rejects a non-positive amount rather than guessing", () => {
    expect(estimatePayout(market({}), "yes", 0n)).toBeNull();
    expect(estimatePayout(market({}), "yes", -1n)).toBeNull();
  });
});

describe("impliedYesPercent", () => {
  it("is null with no stakes, rather than a misleading 50%", () => {
    expect(impliedYesPercent(market({ yesPool: 0n, noPool: 0n }))).toBeNull();
  });

  it("reads the pools as a probability", () => {
    expect(impliedYesPercent(market({ yesPool: 3_000_000n, noPool: 1_000_000n }))).toBe(75);
    expect(impliedYesPercent(market({ yesPool: 1_000_000n, noPool: 1_000_000n }))).toBe(50);
  });
});

describe("isOneSided", () => {
  it("flags a book that can only void", () => {
    expect(isOneSided(market({ yesPool: 1_000_000n, noPool: 0n }))).toBe(true);
    expect(isOneSided(market({ yesPool: 0n, noPool: 1_000_000n }))).toBe(true);
  });

  it("does not flag an empty book, which nobody has committed to yet", () => {
    expect(isOneSided(market({ yesPool: 0n, noPool: 0n }))).toBe(false);
  });

  it("does not flag a two-sided book", () => {
    expect(isOneSided(market({ yesPool: 1n, noPool: 1n }))).toBe(false);
  });
});

/**
 * The AMM branches, which this file had no coverage of at all — every case
 * above uses a parimutuel market, so the four functions that special-case the
 * AMM were being exercised only indirectly through the views.
 */
describe("AMM markets", () => {
  const amm = (over: Partial<Market> = {}) => ({ ...amm0, ...over }) as Market;

  it("reads the price off yesPriceBps, not off the reserves", () => {
    const m = amm({ yesPriceBps: 6_282 });
    expect(impliedYesPercent(m)).toBe(62.82);
  });

  /**
   * The reserves are INVERTED relative to a pool ratio: the scarcer YES is in
   * the pool, the dearer it is. Reading them as parimutuel pools would report
   * 37% where the market is quoting 63%.
   */
  it("does not read the reserves the way a parimutuel pool is read", () => {
    const yesReserve = 7_692_308n;
    const noReserve = 13_000_000n;
    const m = amm({ yesPriceBps: 6_282, yesReserve, noReserve });
    const asIfParimutuel = Number((yesReserve * 10_000n) / (yesReserve + noReserve)) / 100;

    expect(impliedYesPercent(m)).toBe(62.82);
    expect(asIfParimutuel).toBeCloseTo(37.18, 1);
  });

  it("reports the collateral as the money at stake, not the reserves", () => {
    expect(totalPool(amm({ collateral: 13_000_000n }))).toBe(13_000_000n);
  });

  /** Every share is individually collateralised, so there is no one-sided void. */
  it("is never one-sided", () => {
    expect(isOneSided(amm({ yesReserve: 1n, noReserve: 0n }))).toBe(false);
  });

  /**
   * There is no pot to divide and no parimutuel formula that applies, so an
   * estimate here would be a made-up number — the trade panel quotes the
   * contract instead.
   */
  it("declines to estimate a payout", () => {
    expect(estimatePayout(amm(), "yes", 1_000_000n)).toBeNull();
  });

  it("pays one unit per winning share", () => {
    const m = amm({ status: MarketStatus.Settled, outcome: Outcome.Yes });
    expect(claimablePayout(m, 5_307_692n, 0n)).toBe(5_307_692n);
    expect(claimablePayout(m, 0n, 5_307_692n)).toBe(0n);
  });

  /**
   * A void pays half a unit per share on EITHER side. Paying both in full is
   * insolvent on its face — one unit of collateral mints one YES and one NO.
   */
  it("pays half a unit per share on a void, either side", () => {
    const m = amm({ status: MarketStatus.Void, outcome: Outcome.Void });
    expect(claimablePayout(m, 4_000_000n, 2_000_000n)).toBe(3_000_000n);
  });
});


/**
 * Which markets the board is for.
 *
 * This deployment carries about twenty markets that resolved without anyone
 * ever staking on them — flights replayed to check the provider, backtests
 * against a feed round, markets created purely to see whether a handler fires.
 * They are real history and they stay on chain, but they describe the testing
 * rather than the product.
 *
 * The two mistakes worth guarding are opposite: hiding an OPEN market with no
 * stakes yet, which is the one thing a visitor can act on; and keeping a
 * resolved one that nobody ever touched.
 */
describe("isUnstakedAndResolved", () => {
  const at = (status: MarketStatus, yes: bigint, no: bigint): Market =>
    ({ ...crypto0, status, yesPool: yes, noPool: no }) as Market;

  it("hides a settled market nobody staked on", () => {
    expect(isUnstakedAndResolved(at(MarketStatus.Settled, 0n, 0n))).toBe(true);
  });

  it("hides a voided market nobody staked on", () => {
    expect(isUnstakedAndResolved(at(MarketStatus.Void, 0n, 0n))).toBe(true);
  });

  it("keeps an OPEN market with no stakes — that is an invitation, not a test", () => {
    expect(isUnstakedAndResolved(at(MarketStatus.Open, 0n, 0n))).toBe(false);
    expect(isUnstakedAndResolved(at(MarketStatus.Locked, 0n, 0n))).toBe(false);
    expect(isUnstakedAndResolved(at(MarketStatus.SettlementRequested, 0n, 0n))).toBe(false);
  });

  it("keeps a resolved market that anyone staked on, on either side", () => {
    expect(isUnstakedAndResolved(at(MarketStatus.Settled, 1n, 0n))).toBe(false);
    expect(isUnstakedAndResolved(at(MarketStatus.Void, 0n, 1n))).toBe(false);
  });

  /**
   * An AMM market holds no pools — its money is `collateral`, and reading
   * yes/no would call a live ladder unstaked. `totalPool` already knows this,
   * which is why the check goes through it rather than adding the two fields.
   */
  it("measures an AMM market by its collateral, not by pools", () => {
    const seeded = { ...amm0, status: MarketStatus.Settled, collateral: 40_000_000n } as Market;
    const empty = { ...amm0, status: MarketStatus.Settled, collateral: 0n } as Market;
    expect(isUnstakedAndResolved(seeded)).toBe(false);
    expect(isUnstakedAndResolved(empty)).toBe(true);
  });
});
