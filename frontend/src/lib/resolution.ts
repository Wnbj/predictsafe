import { formatMarketValue, formatToken } from "./format";
import { isOneSided, totalPool } from "./pricing";
import { resultLabel } from "./sports";
import { isAmm, isPriceMarket, MarketStatus, Outcome, type Market } from "./types";

/**
 * What a resolved market's card says instead of odds.
 *
 * A card used to keep showing the last implied chance after settlement —
 * "Yes 20% · No 80%" on a market that had resolved Yes, three outcomes of a
 * football match adding to 123% after the match was over, "Yes 100%" on a
 * market that had been voided and refunded. Odds are a forecast; once the
 * answer is known the card states the answer, and what the oracle observed.
 */
export interface Resolution {
  /** "yes" and "no" colour the headline; "void" reads neutral. */
  tone: "yes" | "no" | "void";
  headline: string;
  /** What decided it, or why it was voided. */
  detail: string | null;
}

export function resolutionOf(m: Market): Resolution | null {
  if (m.status === MarketStatus.Void) {
    if (m.categoryId === "sports") return { tone: "void", headline: "Void", detail: resultLabel(m) };
    const pool = totalPool(m);
    const detail = isOneSided(m)
      ? "nobody took the other side · stakes refunded"
      : pool === 0n
        ? "no stakes were placed"
        : isAmm(m)
          ? "shares redeem at half a unit"
          : `${formatToken(pool)} refunded`;
    return { tone: "void", headline: "Void", detail };
  }
  if (m.status !== MarketStatus.Settled) return null;
  if (m.outcome !== Outcome.Yes && m.outcome !== Outcome.No) return null;

  const tone = m.outcome === Outcome.Yes ? "yes" : "no";
  const headline = `Resolved ${m.outcome === Outcome.Yes ? "Yes" : "No"}`;
  if (m.categoryId === "sports") return { tone, headline: resultLabel(m) ?? headline, detail: null };
  if (m.categoryId === "flights") {
    const d = m.observedDelay;
    return {
      tone,
      headline,
      detail: d < 0 ? `landed ${-d} min early` : `${d} min late · threshold ${m.thresholdMinutes} min`,
    };
  }
  if (isPriceMarket(m) && m.observedPrice > 0n) {
    return {
      tone,
      headline,
      detail: `${formatMarketValue(m.categoryId, m.observedPrice)} vs ${formatMarketValue(m.categoryId, m.strikePrice)}`,
    };
  }
  return { tone, headline, detail: null };
}
