import { describe, expect, it } from "vitest";
import {
  canCancel,
  CANCEL_AFTER_SECONDS,
  estimateBuy,
  estimateSell,
  holdingsFor,
  lastPriceChange,
  marketState,
  medianGap,
  orderLabel,
  valueOf,
  type ExchangeAsset,
  type ExchangeOrder,
  type ExchangeState,
  type FeedRound,
} from "./exchange";

/**
 * The exchange page's arithmetic and wording.
 *
 * The estimate on screen must be the number the contract will compute at the
 * same price, or the page promises one amount and the chain pays another. The
 * cases below reuse the figures from `AssetExchange.t.sol` for that reason.
 */

const P1 = 4_400n * 10n ** 8n; // $4,400.00 at the feed's 8 decimals

describe("estimates mirror the contract", () => {
  it("prices a buy exactly as _settle does", () => {
    const fee = (1_000_000_000n * 30n) / 10_000n;
    const { fee: f, tokens } = estimateBuy(1_000_000_000n, P1, 8);
    expect(f).toBe(fee);
    expect(tokens).toBe(((1_000_000_000n - fee) * 10n ** 20n) / P1);
  });

  it("prices a sell exactly as _settle does", () => {
    const tokens = 226_590_909_090_909_090n;
    const price = 4_840n * 10n ** 8n;
    const gross = (tokens * price) / 10n ** 20n;
    const { payout, fee } = estimateSell(tokens, price, 8);
    expect(fee).toBe((gross * 30n) / 10_000n);
    expect(payout).toBe(gross - fee);
  });

  it("round-trips a buy and a sell at one price to the fees, and no more", () => {
    const { tokens } = estimateBuy(1_000_000_000n, P1, 8);
    const { payout } = estimateSell(tokens, P1, 8);
    // Two 0.3% fees on 1,000 is about 5.99; integer division may drop a unit.
    expect(1_000_000_000n - payout).toBeGreaterThanOrEqual(5_990_000n);
    expect(1_000_000_000n - payout).toBeLessThanOrEqual(5_991_000n);
  });

  it("handles a feed with other decimals", () => {
    // USTB NAV publishes 6 decimals: $11.2234.
    const { tokens } = estimateBuy(11_223_400n, 11_223_400n, 6);
    expect(tokens).toBe((11_223_400n - 33_670n) * 10n ** 18n / 11_223_400n);
  });

  it("values a holding without a fee", () => {
    expect(valueOf(10n ** 18n, P1, 8)).toBe(4_400_000_000n);
  });

  it("returns zero rather than dividing by a bad price", () => {
    expect(estimateBuy(1_000n, 0n, 8).tokens).toBe(0n);
    expect(estimateSell(1_000n, -1n, 8).payout).toBe(0n);
  });
});

const round = (answer: bigint, updatedAt: number, id = 0n): FeedRound => ({ roundId: id, answer, updatedAt });

describe("reading a feed's history", () => {
  /**
   * The measured Saturday: 24 rounds of gold at one price. The latest round is
   * fresh; the last CHANGE is Friday's. That difference is the whole page.
   */
  it("finds the last price that moved, not the last round published", () => {
    const friday = round(4_285n, 1_000);
    const saturday = Array.from({ length: 24 }, (_, i) => round(4_285n, 2_000 + i * 3_600));
    const rounds = [round(4_280n, 0), friday, ...saturday];
    expect(lastPriceChange(rounds)).toEqual(friday);
  });

  it("reports no change when every round repeats", () => {
    expect(lastPriceChange([round(1n, 0), round(1n, 10), round(1n, 20)])).toBeNull();
  });

  it("measures cadence as the median gap", () => {
    expect(medianGap([round(1n, 0), round(2n, 3_600), round(3n, 7_200), round(4n, 7_260)])).toBe(3_600);
  });
});

describe("market state", () => {
  const now = 1_000_000;

  it("calls a market with fresh heartbeats and no new price for hours closed", () => {
    const s = marketState(
      { latest: round(1n, now - 60, 30n), lastChange: round(1n, now - 20 * 3_600, 10n), cadenceSeconds: 3_600 },
      now,
    );
    expect(s.state).toBe("closed");
    expect(s.label).toMatch(/closed/);
  });

  /**
   * Friday 25 September, gold: a new price at 22:05 UTC, then at 23:05 a round
   * with the SAME price. Judged by time alone the page said "within about an
   * hour" for two more hours, and orders placed then waited until Sunday. The
   * repeat is the signal, and it counts the moment it lands.
   */
  it("flags a latest round that repeats the price immediately, not hours later", () => {
    const at2205 = round(4_285_625n, now - 3_600, 41n);
    const at2305 = round(4_285_625n, now - 60, 42n);
    const s = marketState({ latest: at2305, lastChange: at2205, cadenceSeconds: 3_600 }, now);
    expect(s.state).toBe("paused");
    expect(s.moving).toBe(false);
    expect(s.label).toMatch(/repeated/);
    expect(s.expectedWait).toMatch(/reopens/);
  });

  it("calls a market whose latest round is its last change moving, and sizes the wait by cadence", () => {
    const r = round(1n, now - 60, 7n);
    const hourly = marketState({ latest: r, lastChange: r, cadenceSeconds: 3_600 }, now);
    expect(hourly.state).toBe("moving");
    expect(hourly.expectedWait).toMatch(/hour/);
    const d = round(1n, now - 3_600, 8n);
    expect(marketState({ latest: d, lastChange: d, cadenceSeconds: 86_400 }, now).expectedWait).toMatch(/day/);
  });
});

describe("holdings", () => {
  const alice = "0x00000000000000000000000000000000000a11ce" as const;
  const bob = "0x00000000000000000000000000000000000000b0" as const;
  const asset = (id: number, balance: bigint): ExchangeAsset => ({
    id, symbol: id === 0 ? "XAU" : "CSPX", name: id === 0 ? "Gold" : "S&P 500",
    feed: "0x0000000000000000000000000000000000000001", token: "0x0000000000000000000000000000000000000002",
    feedDecimals: 8, active: true, latest: round(P1, 0, 1n), lastChange: null, cadenceSeconds: 3_600,
    totalSupply: balance, balance,
  });
  const order = (o: Partial<ExchangeOrder>): ExchangeOrder => ({
    id: 0, trader: alice, assetId: 0, side: "buy", status: "pending", placedRound: 1n, placedAt: 0,
    amountIn: 100_000_000n, amountOut: 0n, fee: 0n, fillRound: 0n, fillPrice: 0n, ready: null, ...o,
  });

  it("shows an asset with waiting orders even before anything is held", () => {
    const state: ExchangeState = {
      assets: [asset(0, 0n), asset(1, 0n)],
      orders: [order({ id: 2 }), order({ id: 3, amountIn: 50_000_000n }), order({ id: 4, trader: bob })],
      reserve: 0n, escrowed: 0n,
    };
    const rows = holdingsFor(state, alice);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.asset.symbol).toBe("XAU");
    expect(rows[0]!.pendingBuys).toBe(2);
    expect(rows[0]!.pendingBuyUsdc).toBe(150_000_000n);
  });

  it("values a holding at the latest price and ignores filled orders", () => {
    const state: ExchangeState = {
      assets: [asset(0, 10n ** 18n)],
      orders: [order({ status: "filled" })],
      reserve: 0n, escrowed: 0n,
    };
    const [h] = holdingsFor(state, alice);
    expect(h!.value).toBe(4_400_000_000n);
    expect(h!.pendingBuys).toBe(0);
  });

  it("leaves out assets with nothing held and nothing waiting", () => {
    const state: ExchangeState = { assets: [asset(0, 0n)], orders: [], reserve: 0n, escrowed: 0n };
    expect(holdingsFor(state, alice)).toEqual([]);
  });
});

describe("orders", () => {
  const alice = "0x00000000000000000000000000000000000a11ce" as const;
  const base: ExchangeOrder = {
    id: 0, trader: alice, assetId: 0, side: "buy", status: "pending",
    placedRound: 1n, placedAt: 1_000, amountIn: 1n, amountOut: 0n, fee: 0n,
    fillRound: 0n, fillPrice: 0n, ready: null,
  };

  it("says what a pending order is waiting for", () => {
    expect(orderLabel(base)).toMatch(/Waiting for the next new price/);
    expect(orderLabel({ ...base, ready: { round: 2n, price: 5n } })).toMatch(/Ready/);
    expect(orderLabel({ ...base, status: "filled" })).toBe("Filled");
  });

  it("lets only the trader cancel, and only after the timeout", () => {
    expect(canCancel(base, alice, 1_000 + CANCEL_AFTER_SECONDS - 1)).toBe(false);
    expect(canCancel(base, alice, 1_000 + CANCEL_AFTER_SECONDS)).toBe(true);
    expect(canCancel(base, "0x00000000000000000000000000000000000000b0", 1_000 + CANCEL_AFTER_SECONDS)).toBe(false);
    expect(canCancel({ ...base, status: "filled" }, alice, 1_000 + CANCEL_AFTER_SECONDS)).toBe(false);
  });
});
