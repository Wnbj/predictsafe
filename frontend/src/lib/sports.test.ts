import { describe, expect, it } from "vitest";
import { amm0 } from "./fixtures";
import { groupIntoEvents } from "./events";
import { formatMarketValue } from "./format";
import { impliedYesPercent, totalPool } from "./pricing";
import { sportsQuestion } from "./chain";
import { matchTitle, outcomeLabel, resultLabel } from "./sports";
import { isAmm, type AmmMarket, type Market, type SportsMarket } from "./types";

/**
 * A football market is an AMM market that is about a match instead of a
 * price. What matters: everything that touches money treats it as an AMM —
 * the bug this project has repeated is code asking about the CATEGORY when it
 * meant the PRICING — and everything a reader sees comes from the match, since
 * the contract stores no question and no strike for it.
 */

const { asset: _asset, strikePrice: _strike, ...ammFields } = amm0 as AmmMarket;

const market = (outcome: 1 | 2 | 3, id: number, priceBps: number, result = 0): SportsMarket => ({
  ...ammFields,
  id,
  key: `sports:${id}`,
  contract: "0xF30D56E3586091dFe63B74338a194d37Cef80906",
  categoryId: "sports",
  question: sportsQuestion("Arsenal", "Chelsea", outcome),
  yesPriceBps: priceBps,
  match: { matchId: 537000, home: "Arsenal", away: "Chelsea", competition: "PL", kickoff: 2_000_000_000, outcome, result },
});

describe("football markets", () => {
  const home = market(1, 0, 4_500);
  const draw = market(2, 1, 2_700);
  const away = market(3, 2, 2_800);

  it("count as AMM markets for everything that touches money", () => {
    expect(isAmm(home)).toBe(true);
    expect(impliedYesPercent(home)).toBe(45);
    expect(totalPool(home)).toBe(home.collateral);
  });

  it("ask their questions from the match", () => {
    expect(home.question).toBe("Will Arsenal beat Chelsea?");
    expect(draw.question).toBe("Will Arsenal v Chelsea end in a draw?");
    expect(away.question).toBe("Will Chelsea win at Arsenal?");
    expect(matchTitle(home)).toBe("Arsenal v Chelsea");
    expect([outcomeLabel(home), outcomeLabel(draw), outcomeLabel(away)]).toEqual(["Arsenal", "Draw", "Chelsea"]);
  });

  it("group a match's three markets into one event, home first", () => {
    const events = groupIntoEvents([away, home, draw, amm0 as Market]);
    const match = events.find((e) => e.rungs.length === 3)!;
    expect(match.rungs.map((m) => m.key)).toEqual([home.key, draw.key, away.key]);
    expect(events).toHaveLength(2);
  });

  it("say what happened, not a price", () => {
    expect(resultLabel(market(1, 0, 0, 3))).toBe("Chelsea won");
    expect(resultLabel(market(1, 0, 0, 4))).toMatch(/^Void/);
    expect(resultLabel(home)).toBeNull();
    expect(formatMarketValue("sports", 2n)).toBe("draw");
  });
});
