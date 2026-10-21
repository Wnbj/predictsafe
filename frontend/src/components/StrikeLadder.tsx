import { formatMarketValue, formatPercent } from "../lib/format";
import { outcomeLabel } from "../lib/sports";
import { impliedYesPercent } from "../lib/pricing";
import { isPriceMarket, MarketStatus, Outcome, type Market } from "../lib/types";
import type { MarketEvent } from "../lib/events";

/**
 * Every strike on one question, as a single ladder.
 *
 * The point of a ladder is that the numbers only mean anything next to each
 * other: 45% on its own says little, 85 / 70 / 45 / 25 / 12 across rising
 * strikes is the market's whole view of where the price will land. Splitting
 * that into five cards throws the shape away.
 */
/**
 * A resolved rung shows its answer, not the odds it closed at: three outcomes
 * of a finished match read 68% / 27% / 28% — 123% — about a game already won.
 */
function rungResult(m: Market): { text: string; won: boolean } | null {
  if (m.status === MarketStatus.Void) return { text: "Void", won: false };
  if (m.status !== MarketStatus.Settled) return null;
  const won = m.outcome === Outcome.Yes;
  if (m.categoryId === "sports") return { text: won ? "✓ Won" : "—", won };
  return { text: won ? "✓ Yes" : "No", won };
}

export function StrikeLadder({
  event,
  selectedKey,
  onOpen,
  compact = false,
}: {
  event: MarketEvent;
  selectedKey?: string;
  onOpen: (key: string) => void;
  compact?: boolean;
}) {
  // Highest strike first: the least likely outcome on top, the way an option
  // chain is read. A match keeps its own order — home, draw, away.
  const sports = event.rungs[0]?.categoryId === "sports";
  const rungs = sports ? event.rungs : [...event.rungs].reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 2 : 4 }}>
      {rungs.map((m) => {
        const yes = impliedYesPercent(m);
        const result = rungResult(m);
        const isSelected = m.key === selectedKey;
        return (
          <button
            key={m.key}
            onClick={(e) => {
              // The whole card is clickable in the markets list, so a rung
              // must not open the card as well as itself.
              e.stopPropagation();
              onOpen(m.key);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              width: "100%",
              padding: compact ? "3px 8px" : "7px 10px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontFamily: "var(--font-body)",
              fontSize: compact ? 11 : 13,
              textAlign: "left",
              color: "var(--color-text)",
              border: `1px solid ${isSelected ? "var(--color-accent)" : "transparent"}`,
              background: isSelected
                ? "color-mix(in srgb, var(--color-accent) 14%, transparent)"
                : "color-mix(in srgb, var(--color-text) 5%, transparent)",
            }}
          >
            <span style={{ whiteSpace: "nowrap" }}>
              {m.categoryId === "sports"
                ? outcomeLabel(m)
                : isPriceMarket(m)
                  ? formatMarketValue(m.categoryId, m.strikePrice)
                  : m.question}
              {!compact && !sports && " or above"}
            </span>

            {result ? (
              <span
                className="heading"
                style={{
                  flexShrink: 0,
                  color: result.won ? "var(--color-accent-300)" : "var(--color-neutral-500)",
                }}
              >
                {result.text}
              </span>
            ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {/* A bar makes the curve readable at a glance; the number alone
                  requires the reader to do the comparing. */}
              <span
                aria-hidden="true"
                style={{
                  width: compact ? 34 : 56,
                  height: 4,
                  borderRadius: 2,
                  background: "color-mix(in srgb, var(--color-text) 12%, transparent)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${yes ?? 0}%`,
                    height: "100%",
                    background: "var(--color-accent)",
                  }}
                />
              </span>
              <span
                className="heading"
                style={{
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 34,
                  textAlign: "right",
                  color: yes === null ? "var(--color-neutral-500)" : undefined,
                }}
              >
                {yes === null ? "—" : formatPercent(yes)}
              </span>
            </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
