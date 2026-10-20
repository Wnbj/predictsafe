import type { Market, SportsMarket } from "./types";

/**
 * Words for football markets. SportsMarket stores no question and no strike —
 * a match is three markets that differ only in which outcome they ask about —
 * so everything a reader sees is composed here from the match.
 */

export const isSports = (m: Market): m is SportsMarket => m.categoryId === "sports";

/** The outcome a market asks about, as a rung label: the team, or "Draw". */
export function outcomeLabel(m: SportsMarket): string {
  return m.match.outcome === 1 ? m.match.home : m.match.outcome === 3 ? m.match.away : "Draw";
}

/** "Arsenal v Chelsea" — the title a match's three markets share. */
export const matchTitle = (m: SportsMarket): string => `${m.match.home} v ${m.match.away}`;

const COMPETITIONS: Record<string, string> = {
  PL: "Premier League",
  CL: "Champions League",
  PD: "La Liga",
  SA: "Serie A",
  BL1: "Bundesliga",
  FL1: "Ligue 1",
};

export const competitionName = (code: string): string => COMPETITIONS[code] ?? code;

/** A settled match's result, as the DON reported it. */
export function resultLabel(m: SportsMarket): string | null {
  switch (m.match.result) {
    case 1:
      return `${m.match.home} won`;
    case 2:
      return "Draw";
    case 3:
      return `${m.match.away} won`;
    case 4:
      return "Void — postponed or not reported";
    default:
      return null;
  }
}
