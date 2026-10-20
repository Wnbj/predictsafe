import { describe, expect, it } from "vitest";
import { attributeFees, buildLpPosition, lpPnl, markPoolValue, markShares, residualValue, residualsByMarket } from "./lp";
import { MarketStatus, Outcome, type LpEvent, type Market, type TradeEvent } from "./types";
import { amm0 } from "./fixtures";

/**
 * Liquidity valuation.
 *
 * The property under test throughout is that a provider is credited for what
 * happened WHILE THEY WERE PROVIDING, and for nothing else. The contract gets
 * this right by construction — fees inflate the reserves without minting
 * shares, so a later deposit buys proportionally fewer — and the display has
 * to reproduce it from events rather than quietly averaging it away.
 */

const alice = "0x00000000000000000000000000000000000a11ce" as const;
const bob = "0x0000000000000000000000000000000000000b0b" as const;

const key = amm0.key;

const deposit = (
  provider: `0x${string}`,
  amount: bigint,
  lpShares: bigint,
  totalLpShares: bigint,
  blockNumber: bigint,
): LpEvent => ({
  marketKey: key,
  provider,
  direction: "add",
  amount,
  lpShares,
  totalLpShares,
  blockNumber,
  txHash: "0x00",
});

const trade = (fee: bigint, blockNumber: bigint): TradeEvent => ({
  marketKey: key,
  user: bob,
  isYes: true,
  amount: 1_000_000n,
  blockNumber,
  txHash: "0x00",
  amm: { direction: "buy", shares: 1_500_000n, fee },
});

describe("attributeFees", () => {
  it("gives the whole fee to a sole provider", () => {
    const fees = attributeFees([deposit(alice, 10_000_000n, 10_000_000n, 10_000_000n, 1n)], [
      trade(30_000n, 2n),
    ]);
    expect(fees.get(key)?.get(alice)).toBe(30_000n);
  });

  it("splits a fee by shares held at the time of the trade", () => {
    const lpEvents = [
      deposit(alice, 10_000_000n, 10_000_000n, 10_000_000n, 1n),
      deposit(bob, 10_000_000n, 10_000_000n, 20_000_000n, 2n),
    ];
    const fees = attributeFees(lpEvents, [trade(30_000n, 3n)]);

    expect(fees.get(key)?.get(alice)).toBe(15_000n);
    expect(fees.get(key)?.get(bob)).toBe(15_000n);
  });

  /**
   * THE LOAD-BEARING CASE. Taking the lifetime fee total and splitting it by
   * today's shares would hand the late arrival half of a fee earned before
   * they had deposited anything — money the contract never gave them, since
   * their deposit was priced against reserves the fee had already inflated.
   */
  it("does not pay a late provider for fees earned before they arrived", () => {
    const lpEvents = [
      deposit(alice, 10_000_000n, 10_000_000n, 10_000_000n, 1n),
      deposit(bob, 10_000_000n, 10_000_000n, 20_000_000n, 5n),
    ];
    const trades = [trade(30_000n, 2n), trade(30_000n, 6n)];

    const fees = attributeFees(lpEvents, trades);

    // Alice: all of the first fee, half of the second. Bob: half of the second.
    expect(fees.get(key)?.get(alice)).toBe(45_000n);
    expect(fees.get(key)?.get(bob)).toBe(15_000n);
  });

  it("ignores a trade that happened before any liquidity existed", () => {
    const fees = attributeFees(
      [deposit(alice, 10_000_000n, 10_000_000n, 10_000_000n, 5n)],
      [trade(30_000n, 1n)],
    );
    expect(fees.get(key)?.get(alice)).toBeUndefined();
  });

  it("attributes nothing when the market charges no fee", () => {
    const fees = attributeFees(
      [deposit(alice, 10_000_000n, 10_000_000n, 10_000_000n, 1n)],
      [trade(0n, 2n)],
    );
    expect(fees.get(key)?.get(alice)).toBeUndefined();
  });
});

describe("markPoolValue", () => {
  /**
   * A balanced pool is worth its own depth. `2YN/(Y+N)` with `Y == N` is just
   * `Y`, which is the sanity check that the harmonic mean is the right shape.
   */
  it("marks a balanced pool at its reserve level", () => {
    const m = { ...amm0, yesReserve: 10_000_000n, noReserve: 10_000_000n } as Market;
    expect(markPoolValue(m, 10_000_000n, 10_000_000n)).toBe(10_000_000n);
  });

  /**
   * A skewed pool marks BELOW its arithmetic average, and that gap is the
   * structural cost of quoting rather than an artefact — the side the market
   * moved away from is the side the pool is left holding.
   */
  it("marks a skewed pool below the average of its reserves", () => {
    const m = { ...amm0, yesReserve: 4_000_000n, noReserve: 16_000_000n } as Market;
    const marked = markPoolValue(m, 10_000_000n, 10_000_000n);

    expect(marked).toBeLessThan(10_000_000n);
    expect(marked).toBe(6_400_000n);
  });

  it("scales with the fraction of the pool held", () => {
    const m = { ...amm0, yesReserve: 10_000_000n, noReserve: 10_000_000n } as Market;
    expect(markPoolValue(m, 2_500_000n, 10_000_000n)).toBe(2_500_000n);
  });

  it("is zero for a wallet holding no shares", () => {
    expect(markPoolValue(amm0, 0n, 10_000_000n)).toBe(0n);
  });
});

describe("markShares", () => {
  it("values residual shares at the price the book is quoting", () => {
    const m = { ...amm0, yesPriceBps: 6_282 } as Market;
    // 1 mUSDC of YES at 62.82c.
    expect(markShares(m, 1_000_000n, 0n)).toBe(628_200n);
    expect(markShares(m, 0n, 1_000_000n)).toBe(371_800n);
  });
});

describe("buildLpPosition", () => {
  const settled = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;

  it("uses the chain's own claimable once the market has settled", () => {
    const lp = buildLpPosition(
      settled,
      { shares: 10_000_000n, totalShares: 10_000_000n, withdrawn: false, claimable: 7_058_823n },
      10_000_000n,
      30_000n,
    );

    expect(lp?.poolValue).toBe(7_058_823n);
    expect(lp?.marked).toBe(false);
  });

  it("marks the position while the market is still open", () => {
    const lp = buildLpPosition(
      amm0,
      { shares: 10_000_000n, totalShares: 10_000_000n, withdrawn: false, claimable: 0n },
      10_000_000n,
      0n,
    );

    expect(lp?.marked).toBe(true);
    expect(lp?.poolValue).toBeGreaterThan(0n);
  });

  it("returns null for a wallet that never provided", () => {
    expect(buildLpPosition(settled, undefined, 0n, 0n)).toBeNull();
  });

  /** A withdrawn position still has to report what it was worth. */
  it("keeps the value after withdrawal, flagged", () => {
    const lp = buildLpPosition(
      settled,
      { shares: 10_000_000n, totalShares: 10_000_000n, withdrawn: true, claimable: 7_058_823n },
      10_000_000n,
      0n,
    );

    expect(lp?.withdrawn).toBe(true);
    expect(lp?.poolValue).toBe(7_058_823n);
  });
});

describe("lpPnl", () => {
  const lp = {
    shares: 10_000_000n,
    totalShares: 10_000_000n,
    deposited: 10_000_000n,
    feesEarned: 500_000n,
    poolValue: 8_000_000n,
    withdrawn: false,
    marked: false,
    residualYes: 0n,
    residualNo: 0n,
  };

  /**
   * The identity the split exists to express: what you made is what the fees
   * brought in less what the traders took, so reporting only the net loses
   * which of the two happened.
   */
  it("splits the result into fees earned and impermanent loss", () => {
    const { value, pnl, impermanentLoss } = lpPnl(lp, 1_000_000n);

    expect(value).toBe(9_000_000n);
    expect(pnl).toBe(-1_000_000n);
    expect(impermanentLoss).toBe(1_500_000n);
    // pnl == feesEarned - impermanentLoss
    expect(lp.feesEarned - impermanentLoss).toBe(pnl);
  });

  it("shows a profit when fees outrun the divergence", () => {
    const { pnl } = lpPnl({ ...lp, poolValue: 10_500_000n }, 0n);
    expect(pnl).toBe(500_000n);
  });

  /** Providing to a market nobody traded returns the deposit and nothing else. */
  it("is flat for an untouched pool", () => {
    const { pnl, impermanentLoss } = lpPnl(
      { ...lp, poolValue: 10_000_000n, feesEarned: 0n },
      0n,
    );
    expect(pnl).toBe(0n);
    expect(impermanentLoss).toBe(0n);
  });

  /**
   * The residual value passed in must be the SHARES alone. `lpPnl` adds the
   * pool claim itself, so handing it a whole-market entitlement — which
   * already contains that claim — counts the pool twice and reports a provider
   * who merely got their deposit back as up by the size of their own claim.
   * A settled rung: 40 in, 13.333333 left in the pool, 26.666667 in shares.
   */
  it("is flat when a settled pool returns exactly the deposit", () => {
    const settled = {
      ...lp,
      deposited: 40_000_000n,
      poolValue: 13_333_333n,
      feesEarned: 0n,
      marked: false,
      residualYes: 0n,
      residualNo: 0n,
    };

    const { value, pnl, impermanentLoss } = lpPnl(settled, 26_666_667n);
    expect(value).toBe(40_000_000n);
    expect(pnl).toBe(0n);
    expect(impermanentLoss).toBe(0n);

    // What the double count looked like: the pool claim, reported as profit.
    expect(lpPnl(settled, 40_000_000n).pnl).toBe(13_333_333n);
  });
});

/**
 * The liquidity P&L values the shares the DEPOSIT handed back — not every
 * share the wallet holds. Measured on football market 0, 2026-10-20: 11 mUSDC
 * of Yes and 41 of No bought, then 10 deposited at a 4.12% Yes price, which
 * handed back 9.569380 No. Counting all 16.69 Yes and 67.80 No showed
 * "+56.52 mUSDC (IL +56.52)" for a deposit that was flat.
 */
describe("residual shares", () => {
  const market = { ...amm0, yesPriceBps: 412 } as typeof amm0;
  const lp = {
    shares: 2_207_222n,
    totalShares: 12_207_222n,
    deposited: 10_000_000n,
    feesEarned: 0n,
    poolValue: 825_000n,
    withdrawn: false,
    marked: true,
    residualYes: 0n,
    residualNo: 9_569_380n,
  };

  it("counts only what the deposits handed back, so a fresh deposit is flat", () => {
    const value = residualValue(market, lp, 16_694_246n, 67_800_239n);
    expect(value).toBe((9_569_380n * 9_588n) / 10_000n);
    const { pnl } = lpPnl(lp, value);
    // Within a cent of zero: the deposit moved no value, only rounding.
    expect(pnl > -10_000n && pnl < 10_000n).toBe(true);
  });

  it("never counts more than the wallet still holds", () => {
    expect(residualValue(market, lp, 0n, 1_000_000n)).toBe((1_000_000n * 9_588n) / 10_000n);
  });

  it("sums each deposit's residuals per market, for this wallet only", () => {
    const me = "0x00000000000000000000000000000000000a11ce";
    const ev = (provider: string, no: bigint) => ({
      marketKey: "sports:0",
      provider: provider as `0x${string}`,
      direction: "add" as const,
      amount: 10_000_000n,
      lpShares: 1n,
      totalLpShares: 1n,
      yesResidual: 0n,
      noResidual: no,
      blockNumber: 1n,
      txHash: "0x" as `0x${string}`,
    });
    const r = residualsByMarket([ev(me, 5n), ev(me, 7n), ev("0x00000000000000000000000000000000000000b0", 100n)], me);
    expect(r.get("sports:0")).toEqual({ yes: 0n, no: 12n });
  });
});
