import { useMemo, useState } from "react";
import { CATEGORIES } from "../lib/categories";
import { isUnstakedAndResolved, totalPool } from "../lib/pricing";
import type { CategoryId, Market, TradeEvent } from "../lib/types";
import { MarketCard } from "../components/MarketCard";
import { groupIntoEvents, isLadder } from "../lib/events";

type SortMode = "backed" | "newest" | "closing";

const SORTS: { key: SortMode; label: string }[] = [
  { key: "backed", label: "Most backed" },
  { key: "newest", label: "Newest" },
  { key: "closing", label: "Closing soon" },
];

export function Markets({
  markets,
  tradeEvents,
  categoryFilter,
  onCategoryFilter,
  onOpenMarket,
}: {
  markets: Market[];
  tradeEvents: TradeEvent[];
  categoryFilter: CategoryId | "all";
  onCategoryFilter: (c: CategoryId | "all") => void;
  onOpenMarket: (key: string) => void;
}) {
  const [sort, setSort] = useState<SortMode>("backed");
  const [showRehearsals, setShowRehearsals] = useState(false);

  /**
   * Markets that resolved without anyone staking — see `isUnstakedAndResolved`.
   * Counted before they are removed, because the count is what makes hiding
   * them honest: nothing here is deleted, and one click brings them back.
   */
  const inCategory = useMemo(
    () =>
      categoryFilter === "all"
        ? markets
        : markets.filter((m) => m.categoryId === categoryFilter),
    [markets, categoryFilter],
  );
  const rehearsalCount = useMemo(
    () => inCategory.filter(isUnstakedAndResolved).length,
    [inCategory],
  );

  const filtered = useMemo(() => {
    let out = showRehearsals
      ? [...inCategory]
      : inCategory.filter((m) => !isUnstakedAndResolved(m));

    if (sort === "backed") {
      out.sort((a, b) => {
        const d = totalPool(b) - totalPool(a);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      });
    } else if (sort === "newest") {
      out.sort((a, b) => b.id - a.id);
    } else {
      out.sort((a, b) => a.closeTime - b.closeTime);
    }
    return out;
  }, [inCategory, showRehearsals, sort]);

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Markets
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)" }}>
        {filtered.length} market{filtered.length === 1 ? "" : "s"}
        {rehearsalCount > 0 && (
          <>
            {" · "}
            <button
              type="button"
              className="linklike"
              onClick={() => setShowRehearsals((v) => !v)}
            >
              {showRehearsals
                ? `hide ${rehearsalCount} test market${rehearsalCount === 1 ? "" : "s"}`
                : `${rehearsalCount} test market${rehearsalCount === 1 ? "" : "s"} hidden`}
            </button>
          </>
        )}
      </p>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "var(--space-6)",
          flexWrap: "wrap",
          gap: "var(--space-3)",
        }}
      >
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <button
            className={`pill${categoryFilter === "all" ? " active" : ""}`}
            onClick={() => onCategoryFilter("all")}
          >
            All
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`pill${categoryFilter === c.id ? " active" : ""}`}
              onClick={() => onCategoryFilter(c.id)}
              disabled={!c.live}
              title={c.live ? c.blurb : "Coming soon"}
            >
              {c.name}
              {!c.live && " ·"}
            </button>
          ))}
        </div>

        <div className="seg">
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={sort === s.key ? "active" : ""}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="heading" style={{ fontSize: 17 }}>
            Nothing here yet
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            No markets match this filter.
          </div>
        </div>
      ) : (
        <div className="grid-3" style={{ maxWidth: 1300 }}>
          {/* Ladders collapse to one card. Five near-identical cards for what a
              reader sees as one question is the noise a ladder removes, and it
              also throws away the shape — the rungs only mean anything next to
              each other. */}
          {groupIntoEvents(filtered).map((event) => (
            <MarketCard
              key={event.key}
              market={event.featured}
              ladder={isLadder(event) ? event : undefined}
              events={tradeEvents}
              onOpen={onOpenMarket}
            />
          ))}
        </div>
      )}
    </div>
  );
}
