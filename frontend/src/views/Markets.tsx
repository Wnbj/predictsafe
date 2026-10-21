import { useMemo, useState } from "react";
import { CATEGORIES } from "../lib/categories";
import { isActive, isUnstakedAndResolved, totalPool } from "../lib/pricing";
import type { CategoryId, Market, TradeEvent } from "../lib/types";
import { MarketCard } from "../components/MarketCard";
import { groupIntoEvents, isLadder } from "../lib/events";
import { CreateMarket } from "../components/CreateMarket";
import { formatToken } from "../lib/format";
import type { WalletState } from "../hooks/useWallet";

type SortMode = "backed" | "newest" | "closing";
type StatusFilter = "all" | "active" | "resolved";

const STATUSES: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "resolved", label: "Resolved" },
];

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
  wallet,
  onCreated,
}: {
  wallet: WalletState;
  /** A market was just created: refresh, then open it. */
  onCreated: (key: string) => Promise<void>;
  markets: Market[];
  tradeEvents: TradeEvent[];
  categoryFilter: CategoryId | "all";
  onCategoryFilter: (c: CategoryId | "all") => void;
  onOpenMarket: (key: string) => void;
}) {
  const [sort, setSort] = useState<SortMode>("backed");
  const [showRehearsals, setShowRehearsals] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("active");
  const [creating, setCreating] = useState(false);

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

  /**
   * The test-market and status filters, shared by the board and by every
   * count on this page — the tab numbers used to skip the status filter and
   * read "Crypto 22" over a board showing far fewer active markets.
   */
  const shown = (ms: Market[]) => {
    let out = showRehearsals ? [...ms] : ms.filter((m) => !isUnstakedAndResolved(m));
    if (status === "active") out = out.filter(isActive);
    else if (status === "resolved") out = out.filter((m) => !isActive(m));
    return out;
  };

  const filtered = useMemo(() => {
    const out = shown(inCategory);

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
    // Whatever the sort, anything still active comes first: "Most backed" put
    // weeks-old settled markets at the top of a board people come to trade on.
    // Array.sort is stable, so the chosen order holds within each half.
    out.sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown` reads only showRehearsals and status
  }, [inCategory, showRehearsals, sort, status]);

  // Counted in CARDS, as the board shows them: a match is three markets and a
  // ladder up to five, but each is one card and one question to a reader.
  const cards = useMemo(() => groupIntoEvents(filtered), [filtered]);
  const activeCount = useMemo(() => groupIntoEvents(inCategory.filter(isActive)).length, [inCategory]);

  const pooled = inCategory.reduce((sum, m) => sum + totalPool(m), 0n);
  const visible = (c: CategoryId | "all") =>
    groupIntoEvents(shown(c === "all" ? markets : markets.filter((m) => m.categoryId === c))).length;

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-6)" }}>
        Markets
      </h2>

      <section className="wallet markets-head" aria-label="Filter markets">
        <div className="wallet-head">
          <div>
            <div className="eyebrow">Prediction markets · settled by Chainlink CRE</div>
            <div className="wallet-total">
              {cards.length} market{cards.length === 1 ? "" : "s"}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {rehearsalCount > 0 ? (
                <button type="button" className="linklike" onClick={() => setShowRehearsals((v) => !v)}>
                  {showRehearsals
                    ? `hide ${rehearsalCount} test market${rehearsalCount === 1 ? "" : "s"}`
                    : `${rehearsalCount} test market${rehearsalCount === 1 ? "" : "s"} hidden`}
                </button>
              ) : (
                "every market on chain"
              )}
            </div>
          </div>
          <div className="markets-head-side">
            <div className="positions-stats">
              <div className={activeCount > 0 ? "accent" : undefined}>
                <span>Active</span>
                <b>{activeCount}</b>
              </div>
              <div>
                <span>In pools</span>
                <b>{formatToken(pooled)}</b>
              </div>
            </div>
            {!creating && (
              <button className="btn btn-accent bridge-submit markets-create" onClick={() => setCreating(true)}>
                + Create market
              </button>
            )}
          </div>
        </div>

        <div className="wallet-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={categoryFilter === "all"}
            className={categoryFilter === "all" ? "active" : ""}
            onClick={() => onCategoryFilter("all")}
          >
            All
            <span className="muted-strong" style={{ fontSize: 12 }}>{visible("all")}</span>
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={categoryFilter === c.id}
              className={categoryFilter === c.id ? "active" : ""}
              onClick={() => onCategoryFilter(c.id)}
              disabled={!c.live}
              title={c.live ? c.blurb : "Coming soon"}
            >
              {c.name}
              {c.live ? (
                <span className="muted-strong" style={{ fontSize: 12 }}>{visible(c.id)}</span>
              ) : (
                <span className="muted-strong" style={{ fontSize: 10 }}>soon</span>
              )}
            </button>
          ))}
        </div>

        <div className="markets-sorts">
          <div className="seg">
            {STATUSES.map((s) => (
              <button key={s.key} className={status === s.key ? "active" : ""} onClick={() => setStatus(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="seg">
            {SORTS.map((s) => (
              <button key={s.key} className={sort === s.key ? "active" : ""} onClick={() => setSort(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {creating && (
        <CreateMarket
          wallet={wallet}
          onClose={() => setCreating(false)}
          onCreated={async (key) => {
            setCreating(false);
            await onCreated(key);
          }}
        />
      )}

      {filtered.length === 0 ? (
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="heading" style={{ fontSize: 17 }}>
            {status === "active" ? "No active markets right now" : "Nothing here yet"}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {status === "active"
              ? "Every market has resolved. Open one — it takes a minute and settles on its own."
              : "No markets match this filter."}
          </div>
          {status === "active" && !creating && (
            <button className="btn btn-accent" onClick={() => setCreating(true)} style={{ alignSelf: "flex-start" }}>
              + Create market
            </button>
          )}
        </div>
      ) : (
        <div className="grid-3" style={{ maxWidth: 1300 }}>
          {/* Ladders collapse to one card. Five near-identical cards for what a
              reader sees as one question is the noise a ladder removes, and it
              also throws away the shape — the rungs only mean anything next to
              each other. */}
          {cards.map((event) => (
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
