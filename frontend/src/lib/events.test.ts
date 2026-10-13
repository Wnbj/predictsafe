import { describe, expect, it } from "vitest";
import { groupIntoEvents, isLadder, ladderFor, ladderTitle } from "./events";
import { formatMarketValue } from "./format";
import { MarketStatus, type Market } from "./types";
import { amm0, crypto0, flight0, stock0 } from "./fixtures";
import { marketKey } from "./chain";

/**
 * Grouping markets into events.
 *
 * Membership is derived, not stored: markets on the same contract, over the
 * same asset, resolving at the same instant are the same question and differ
 * only by strike. That is what makes this work retroactively on ladders
 * created before the code existed — and also what makes it easy to get subtly
 * wrong, by grouping two things that merely look alike.
 */

const rung = (id: number, strike: bigint, priceBps: number, expiry = 2_000_003_000): Market =>
  ({
    ...amm0,
    id,
    key: marketKey("amm", id),
    strikePrice: strike,
    yesPriceBps: priceBps,
    expiryTime: expiry,
    question: `Will BTC be at or above $${strike / 100_000_000n} at 17:30?`,
  }) as Market;

// A five-rung ladder, deliberately supplied out of order.
const ladder = [
  rung(3, 63_000_00000000n, 4_500),
  rung(1, 62_500_00000000n, 8_500),
  rung(5, 63_500_00000000n, 1_200),
  rung(2, 62_750_00000000n, 7_000),
  rung(4, 63_250_00000000n, 2_500),
];

describe("groupIntoEvents", () => {
  it("collects rungs sharing an asset and an expiry into one event", () => {
    const events = groupIntoEvents(ladder);
    expect(events).toHaveLength(1);
    expect(events[0]!.rungs).toHaveLength(5);
    expect(isLadder(events[0]!)).toBe(true);
  });

  it("orders rungs by strike regardless of the order they arrived in", () => {
    const strikes = groupIntoEvents(ladder)[0]!.rungs.map((m) =>
      m.categoryId === "amm" ? m.strikePrice : 0n,
    );
    expect(strikes).toEqual([...strikes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  /**
   * The same strikes at a different expiry are a different question — a
   * 5pm ladder and a 7pm ladder must not merge into one ten-rung mess.
   */
  it("does not merge ladders that expire at different times", () => {
    const later = ladder.map((m, i) =>
      rung(10 + i, (m as never as { strikePrice: bigint }).strikePrice, 5_000, 2_000_090_000),
    );
    const events = groupIntoEvents([...ladder, ...later]);
    expect(events).toHaveLength(2);
    expect(events[0]!.rungs).toHaveLength(5);
    expect(events[1]!.rungs).toHaveLength(5);
  });

  it("keeps different assets apart even at the same expiry", () => {
    const eth = { ...rung(9, 1_880_00000000n, 5_000), asset: "ETH" } as Market;
    const events = groupIntoEvents([...ladder, eth]);
    expect(events).toHaveLength(2);
  });

  /**
   * A market with no siblings is not a ladder. Rendering a one-rung "ladder"
   * would be a worse card than the ordinary one.
   */
  it("treats a lone market as an event of one, not a ladder", () => {
    const events = groupIntoEvents([ladder[0]!]);
    expect(events).toHaveLength(1);
    expect(isLadder(events[0]!)).toBe(false);
  });

  it("passes non-price markets through untouched", () => {
    const events = groupIntoEvents([flight0]);
    expect(events).toHaveLength(1);
    expect(events[0]!.rungs).toEqual([flight0]);
    expect(isLadder(events[0]!)).toBe(false);
  });

  it("never loses a market", () => {
    const input = [...ladder, flight0, crypto0, stock0];
    const out = groupIntoEvents(input).flatMap((e) => e.rungs);
    expect(out).toHaveLength(input.length);
    expect(new Set(out.map((m) => m.key))).toEqual(new Set(input.map((m) => m.key)));
  });

  /**
   * The list must not reshuffle when a price moves, or cards jump around
   * under the reader's cursor.
   */
  it("preserves input order across events", () => {
    const events = groupIntoEvents([flight0, ...ladder, crypto0]);
    expect(events[0]!.rungs[0]!.key).toBe(flight0.key);
    expect(events[2]!.rungs[0]!.key).toBe(crypto0.key);
  });
});

describe("featured rung", () => {
  /**
   * The most informative rung is the one the market is undecided about. Taking
   * the middle strike instead would report an accident of how the ladder was
   * laid out rather than what the market believes.
   */
  it("is the rung closest to even odds, not the middle strike", () => {
    const event = groupIntoEvents(ladder)[0]!;
    expect(event.featured.key).toBe(marketKey("amm", 3)); // 45%, nearest 50
  });

  it("follows the odds when the ladder is skewed", () => {
    const skewed = [
      rung(1, 62_500_00000000n, 9_800),
      rung(2, 62_750_00000000n, 9_500),
      rung(3, 63_000_00000000n, 9_100),
      rung(4, 63_250_00000000n, 5_200),
      rung(5, 63_500_00000000n, 200),
    ];
    // The middle strike is 63,000 at 91%; the informative rung is 63,250.
    expect(groupIntoEvents(skewed)[0]!.featured.key).toBe(marketKey("amm", 4));
  });

  it("still picks something when no rung has odds yet", () => {
    const unpriced = ladder.map((m) => ({ ...m, yesPriceBps: 5_000 }) as Market);
    expect(groupIntoEvents(unpriced)[0]!.featured).toBeDefined();
  });
});

describe("ladderFor", () => {
  it("finds the ladder a rung belongs to", () => {
    const found = ladderFor(ladder[0]!, ladder);
    expect(found?.rungs).toHaveLength(5);
  });

  it("returns null for a market with no siblings", () => {
    expect(ladderFor(crypto0, [crypto0, flight0])).toBeNull();
  });

  it("returns null for a market that cannot have strikes at all", () => {
    expect(ladderFor(flight0, [flight0])).toBeNull();
  });

  /** Settled rungs stay in their ladder — the shape is still worth reading. */
  it("keeps settled rungs in the ladder", () => {
    const settled = ladder.map((m) => ({ ...m, status: MarketStatus.Settled }) as Market);
    expect(ladderFor(settled[0]!, settled)?.rungs).toHaveLength(5);
  });
});

describe("ladderTitle", () => {
  it("asks where, not at or above an elided price", () => {
    expect(ladderTitle("Will BTC be at or above $63000 at expiry?")).toBe("Where will BTC be at expiry?");
    expect(ladderTitle("Will ETH be at or above $1,882.50 in 1 hour?")).toBe("Where will ETH be in 1 hour?");
  });

  it("leaves any other wording alone", () => {
    expect(ladderTitle("Will BTC be at or above the low strike?")).toBe("Will BTC be at or above the low strike?");
  });
});

describe("formatMarketValue", () => {
  it("prints a flight's observed value as minutes, not as a price", () => {
    expect(formatMarketValue("flights", 12n)).toBe("12 min");
  });
  it("keeps dollars for prices and drops them for reserve levels", () => {
    expect(formatMarketValue("crypto", 6_306_236_000_000n)).toBe("$63,062.36");
    expect(formatMarketValue("reserves", 900_000_000_000_000n)).toBe("9,000,000.00");
  });
});
