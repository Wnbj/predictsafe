import { describe, expect, it } from "vitest";
import { amm0, crypto0, flight0 } from "./fixtures";
import { resolutionOf } from "./resolution";
import { MarketStatus, Outcome, type Market } from "./types";

/**
 * A resolved card states the answer, never the odds it closed at — the board
 * read "Yes 20% · No 80%" on a market that resolved Yes.
 */
describe("what a resolved card says", () => {
  it("an open market has no resolution", () => {
    expect(resolutionOf(crypto0)).toBeNull();
  });

  it("a settled price market: the outcome and what was observed against the strike", () => {
    const m = { ...crypto0, status: MarketStatus.Settled, outcome: Outcome.Yes, observedPrice: 6_333_888_000_000n } as Market;
    const r = resolutionOf(m)!;
    expect(r.tone).toBe("yes");
    expect(r.headline).toBe("Resolved Yes");
    expect(r.detail).toContain("$63,338.88");
    expect(r.detail).toContain("$63,000");
  });

  it("a flight: minutes late against the threshold, or early", () => {
    const late = { ...flight0, status: MarketStatus.Settled, outcome: Outcome.No, observedDelay: 12 } as Market;
    expect(resolutionOf(late)).toMatchObject({ tone: "no", detail: "12 min late · threshold 30 min" });
    const early = { ...flight0, status: MarketStatus.Settled, outcome: Outcome.No, observedDelay: -5 } as Market;
    expect(resolutionOf(early)!.detail).toBe("landed 5 min early");
  });

  it("a void says why, whatever outcome the oracle recorded alongside it", () => {
    const oneSided = { ...crypto0, status: MarketStatus.Void, outcome: Outcome.Yes, noPool: 0n } as Market;
    expect(resolutionOf(oneSided)).toMatchObject({ tone: "void", headline: "Void", detail: "nobody took the other side · stakes refunded" });
    const empty = { ...crypto0, status: MarketStatus.Void, yesPool: 0n, noPool: 0n } as Market;
    expect(resolutionOf(empty)!.detail).toBe("no stakes were placed");
    const amm = { ...amm0, status: MarketStatus.Void, outcome: Outcome.Void } as Market;
    expect(resolutionOf(amm)!.detail).toBe("shares redeem at half a unit");
  });

  it("a football match names who won, for every one of its three markets", () => {
    const match = { matchId: 1, home: "Como 1907", away: "Man United", competition: "CL", kickoff: 0, outcome: 2 as const, result: 1 };
    const draw = { ...amm0, categoryId: "sports", match, status: MarketStatus.Settled, outcome: Outcome.No } as unknown as Market;
    expect(resolutionOf(draw)).toMatchObject({ tone: "no", headline: "Como 1907 won" });
  });
});
