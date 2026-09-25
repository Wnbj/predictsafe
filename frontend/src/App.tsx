import { useEffect, useMemo, useRef, useState } from "react";
import { Nav } from "./components/Nav";
import { SpotProvider } from "./hooks/useSpot";
import { useWallet } from "./hooks/useWallet";
import { useChainData } from "./hooks/useChainData";
import { useRouter } from "./lib/router";
import { Landing } from "./views/Landing";
import { Markets } from "./views/Markets";
import { Detail } from "./views/Detail";
import { Portfolio } from "./views/Portfolio";
import { Leaderboard } from "./views/Leaderboard";
import { Live } from "./views/Live";
import { Trade } from "./views/Trade";
import type { View } from "./lib/view";
import { MarketStatus } from "./lib/types";
import { eventKeyFor } from "./lib/events";

export default function App() {
  const wallet = useWallet();
  const data = useChainData(wallet.account);
  const router = useRouter();
  const { view, selectedKey, categoryFilter } = router;

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Countdowns and open/closed state depend on wall-clock time.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);


  // Real navigation (switching views, opening a market) pushes a history
  // entry, so the browser's Back button steps back through the app instead
  // of leaving it.
  const navigate = (v: View) => {
    router.navigate({ view: v, selectedKey: v === "detail" ? selectedKey : null });
  };

  const openMarket = (key: string) => {
    router.navigate({ view: "detail", selectedKey: key });
  };

  const selected = data.markets.find((m) => m.key === selectedKey) ?? null;

  /**
   * Scroll to the top on navigation — except when moving between rungs of the
   * same strike ladder.
   *
   * Those are the same question at a different strike, so the reader is
   * comparing, not arriving: throwing them back to the top loses the ladder
   * they were just reading. Opening a genuinely different market still jumps,
   * because that IS new content.
   *
   * The subtlety is that the route arrives before the data does. On a cold
   * load the effect first runs while markets are still being fetched, so the
   * selected market — and with it the ladder it belongs to — is not known yet.
   * Recording that as "no ladder" made the very next rung click look like a
   * fresh navigation and jump to the top, once, only after a page load. So the
   * ladder is recorded whenever it becomes known, and only a change of ROUTE
   * decides whether to scroll.
   */
  const routeId = `${view}:${selectedKey ?? ""}`;
  const eventKey = selected ? eventKeyFor(selected) : null;
  const lastRoute = useRef<{ routeId: string; view: View; eventKey: string | null }>({
    routeId,
    view,
    eventKey: null,
  });

  useEffect(() => {
    const previous = lastRoute.current;

    if (previous.routeId === routeId) {
      // Same route, data caught up. Remember the ladder; do not touch scroll.
      lastRoute.current = { routeId, view, eventKey: eventKey ?? previous.eventKey };
      return;
    }

    const sameLadder =
      view === "detail" &&
      previous.view === "detail" &&
      eventKey !== null &&
      eventKey === previous.eventKey;

    if (!sameLadder) window.scrollTo({ top: 0 });
    lastRoute.current = { routeId, view, eventKey };
  }, [routeId, eventKey, view]);

  // Only poll for assets that still have an unresolved market — a settled
  // market shows the price the oracle used, not a live one.
  const liveSymbols = useMemo(
    () =>
      data.markets.flatMap((m) =>
        (m.categoryId === "crypto" || m.categoryId === "amm") &&
        m.status === MarketStatus.Open
          ? [m.asset]
          : [],
      ),
    [data.markets],
  );

  return (
    <SpotProvider symbols={liveSymbols}>
      <Nav view={view} onNavigate={navigate} wallet={wallet} balance={data.balance} />

      {data.error && (
        <div
          style={{
            padding: "10px var(--page-x)",
            fontSize: 13,
            color: "var(--color-negative)",
            background: "color-mix(in srgb, var(--color-negative) 12%, transparent)",
          }}
        >
          Could not load chain data: {data.error}
        </div>
      )}

      {data.failedCategories.length > 0 && (
        <div
          style={{
            padding: "10px var(--page-x)",
            fontSize: 13,
            color: "var(--color-negative)",
            background: "color-mix(in srgb, var(--color-negative) 12%, transparent)",
          }}
        >
          {data.failedCategories.map((f) => (
            <div key={f.categoryId}>
              <strong>{f.categoryId}</strong> markets could not be read — they are missing from
              every list below, not empty. {f.message.split("\n")[0]}
            </div>
          ))}
        </div>
      )}

      {!data.error && data.historyDegraded && (
        <div
          style={{
            padding: "10px var(--page-x)",
            fontSize: 13,
            color: "var(--color-accent-200)",
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
          }}
        >
          Trade history is unavailable from the RPC right now — charts, activity and the
          leaderboard may be incomplete. Market figures are unaffected.
        </div>
      )}

      {view === "trade" ? (
        // Outside the markets gate: the exchange reads its own contract and
        // has no reason to wait for every market to load first.
        <Trade wallet={wallet} onBalanceChange={data.refresh} />
      ) : data.loading ? (
        <div className="page muted">Loading markets from Sepolia…</div>
      ) : (
        <>
          {view === "landing" && (
            <Landing
              markets={data.markets}
              tradeEvents={data.tradeEvents}
              onNavigate={navigate}
              onOpenMarket={openMarket}
              onPickCategory={(c) => router.navigate({ view: "markets", categoryFilter: c })}
            />
          )}

          {view === "markets" && (
            <Markets
              markets={data.markets}
              tradeEvents={data.tradeEvents}
              categoryFilter={categoryFilter}
              // Filter-pill clicks rewrite the current entry rather than
              // pushing a new one — Back should undo "left this page", not
              // undo every filter click made while on it.
              onCategoryFilter={(c) => router.replace({ categoryFilter: c })}
              onOpenMarket={openMarket}
            />
          )}

          {view === "detail" &&
            (selected ? (
              <Detail
                market={selected}
                markets={data.markets}
                tradeEvents={data.tradeEvents}
                settledEvents={data.settledEvents}
                lpEvents={data.lpEvents}
                positions={data.positions}
                wallet={wallet}
                balance={data.balance}
                allowances={data.allowances}
                now={now}
                onBack={() => navigate("markets")}
                onOpenMarket={openMarket}
                onRefresh={data.refresh}
              />
            ) : (
              <div className="page muted">Market not found.</div>
            ))}

          {view === "portfolio" && (
            <Portfolio
              positions={data.positions}
              wallet={wallet}
              onOpenMarket={openMarket}
              onRefresh={data.refresh}
            />
          )}

          {view === "live" && <Live markets={data.markets} lpEvents={data.lpEvents} />}

          {view === "leaderboard" && (
            <Leaderboard
              markets={data.markets}
              tradeEvents={data.tradeEvents}
              lpEvents={data.lpEvents}
              account={wallet.account}
            />
          )}
        </>
      )}
    </SpotProvider>
  );
}
