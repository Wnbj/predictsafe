import { impliedYesPercent } from "./pricing";
import { isPriceMarket, type Market } from "./types";

/**
 * A group of markets that are the same question at different strikes.
 *
 * Kalshi calls this an event: "BTC price at 5pm" is one thing, and the five
 * rungs beneath it are five ways to bet on it. Five separate cards for what a
 * reader sees as one question is the noise this exists to remove.
 *
 * MEMBERSHIP IS DERIVED, NOT STORED. Markets on the same contract, over the
 * same asset, resolving at the same instant ARE the same question — the strike
 * is the only thing that differs, which is what makes a ladder a ladder. So no
 * contract change and no migration were needed, and every ladder ever created
 * groups itself, including ones made before this code existed.
 */
export interface MarketEvent {
  key: string;
  /** Every market in the group, cheapest strike first. */
  rungs: Market[];
  /** The rung a reader should be shown first — see `atTheMoney`. */
  featured: Market;
  expiryTime: number;
}

/** Markets with no siblings are not a ladder and are left alone. */
export function isLadder(event: MarketEvent): boolean {
  return event.rungs.length > 1;
}

/**
 * The event a market belongs to, or null if it cannot belong to one.
 *
 * Exported because navigation needs it too: switching strikes within one
 * ladder is a lateral move, not opening new content.
 */
export function eventKeyFor(m: Market): string | null {
  // A football match's three markets — home, draw, away — are one event too.
  if (m.categoryId === "sports") return `sports:${m.contract}:${m.match.matchId}`;
  if (!isPriceMarket(m)) return null;
  const asset = m.categoryId === "crypto" || m.categoryId === "amm" ? m.asset : m.symbol;
  return `${m.categoryId}:${m.contract}:${asset}:${m.expiryTime}`;
}

/**
 * The rung closest to even odds.
 *
 * A ladder's most informative rung is the one the market is undecided about —
 * the near-certain ones at either end carry almost no information. Picking the
 * middle strike by price would be wrong instead: which strike sits in the
 * middle is an accident of how the ladder was laid out, while which one is
 * closest to 50% is what the market currently believes.
 */
function atTheMoney(rungs: Market[]): Market {
  let best = rungs[0]!;
  let bestDistance = Infinity;
  for (const m of rungs) {
    const p = impliedYesPercent(m);
    const distance = p === null ? Infinity : Math.abs(p - 50);
    if (distance < bestDistance) {
      best = m;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Group markets into events, preserving the order they arrived in so the
 * markets list does not reshuffle when a price moves.
 */
export function groupIntoEvents(markets: Market[]): MarketEvent[] {
  const byKey = new Map<string, Market[]>();
  const standalone: MarketEvent[] = [];
  const order: string[] = [];

  for (const m of markets) {
    const key = eventKeyFor(m);
    if (key === null) {
      standalone.push({
        key: m.key,
        rungs: [m],
        featured: m,
        expiryTime: m.closeTime,
      });
      order.push(m.key);
      continue;
    }
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(m);
  }

  const events = new Map<string, MarketEvent>();
  for (const [key, rungs] of byKey) {
    const sorted = [...rungs].sort((a, b) => {
      // A match reads home, draw, away — in the order the outcomes are numbered.
      if (a.categoryId === "sports" && b.categoryId === "sports") return a.match.outcome - b.match.outcome;
      const sa = isPriceMarket(a) ? a.strikePrice : 0n;
      const sb = isPriceMarket(b) ? b.strikePrice : 0n;
      return sa === sb ? 0 : sa < sb ? -1 : 1;
    });
    events.set(key, {
      key,
      rungs: sorted,
      featured: atTheMoney(sorted),
      expiryTime: isPriceMarket(sorted[0]!) || sorted[0]!.categoryId === "sports" ? sorted[0]!.expiryTime : sorted[0]!.closeTime,
    });
  }

  for (const s of standalone) events.set(s.key, s);
  return order.map((k) => events.get(k)!).filter(Boolean);
}

/** The ladder a given market belongs to, or null when it stands alone. */
export function ladderFor(market: Market, markets: Market[]): MarketEvent | null {
  const key = eventKeyFor(market);
  if (key === null) return null;
  const event = groupIntoEvents(markets).find((e) => e.key === key);
  return event && isLadder(event) ? event : null;
}

/**
 * The question a whole ladder asks, recovered from one rung's question.
 *
 * There is no event title on chain — every rung embeds its own strike — so a
 * ladder card used to cut the price out and leave "Will BTC be at or above …
 * at expiry?", which reads as a rendering fault. The rungs share the asset and
 * the moment, and differ only in the level, so the honest headline asks WHERE.
 * Anything not in the "at or above $X" form is returned as it is.
 */
export function ladderTitle(question: string): string {
  const m = /^Will (.+?) be at or above \$[\d,]+(?:\.\d+)?\s*(.*?)\?$/.exec(question.trim());
  if (!m) return question;
  const [, asset, when] = m;
  return when ? `Where will ${asset} be ${when}?` : `Where will ${asset} be?`;
}
