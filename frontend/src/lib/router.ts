import { useCallback, useEffect, useState } from "react";
import type { CategoryId } from "./types";
import type { View } from "./view";

/**
 * Minimal client-side router — no library, since the app has five fixed
 * views and pulling in react-router for that is more surface than the
 * problem needs.
 *
 * The bug this exists to fix: the app previously tracked `view` as plain
 * `useState`, never touching `window.history`. Every in-app navigation was
 * invisible to the browser, so there was nothing for the Back button to
 * step back through — it left the app entirely on the first press.
 */

export interface RouteState {
  view: View;
  /**
   * Composite market key (`"crypto:2"`), not a bare id. Each market contract
   * numbers its markets from 0, so `/markets/2` alone would be ambiguous
   * between a flight and a crypto market.
   */
  selectedKey: string | null;
  categoryFilter: CategoryId | "all";
}

const LANDING: RouteState = { view: "landing", selectedKey: null, categoryFilter: "all" };

export function parse(pathname: string, search: string): RouteState {
  const category = (new URLSearchParams(search).get("category") ?? "all") as CategoryId | "all";

  if (pathname === "/") return LANDING;

  // URL form is /markets/<category>/<id>, mapping to the "<category>:<id>" key.
  const marketMatch = /^\/markets\/([a-z]+)\/(\d+)$/.exec(pathname);
  if (marketMatch) {
    return {
      view: "detail",
      selectedKey: `${marketMatch[1]}:${marketMatch[2]}`,
      categoryFilter: category,
    };
  }
  if (pathname === "/markets") return { view: "markets", selectedKey: null, categoryFilter: category };
  if (pathname === "/portfolio") return { view: "portfolio", selectedKey: null, categoryFilter: "all" };
  if (pathname === "/leaderboard") return { view: "leaderboard", selectedKey: null, categoryFilter: "all" };
  if (pathname === "/live") return { view: "live", selectedKey: null, categoryFilter: "all" };
  if (pathname === "/trade") return { view: "trade", selectedKey: null, categoryFilter: "all" };

  // Unknown path — treat as landing, and see the mount effect below for why
  // the address bar gets corrected to match.
  return LANDING;
}

export function buildPath(state: RouteState): string {
  switch (state.view) {
    case "landing":
      return "/";
    case "markets":
      return state.categoryFilter === "all" ? "/markets" : `/markets?category=${state.categoryFilter}`;
    case "detail":
      return state.selectedKey === null
        ? "/markets"
        : `/markets/${state.selectedKey.replace(":", "/")}`;
    case "portfolio":
      return "/portfolio";
    case "leaderboard":
      return "/leaderboard";
    case "live":
      return "/live";
    case "trade":
      return "/trade";
  }
}

/**
 * Paths the app owns, for the mount-time address-bar correction below.
 *
 * Exported and tested against `buildPath` for every `View`, because this is the
 * one step of adding a route that the compiler cannot enforce: the union, the
 * switch and the parse branch all fail loudly if forgotten, while forgetting
 * this quietly rewrites a deep link to `/` and looks like the link was wrong.
 */
export const KNOWN_PATHS = /^\/(markets|portfolio|leaderboard|live|trade)/;

export interface Router extends RouteState {
  /** Pushes a new history entry — for real navigation (view/market changes). */
  navigate: (next: Partial<RouteState>) => void;
  /** Rewrites the current entry — for in-page state (filter pills) that
   *  shouldn't make Back step through every click. */
  replace: (next: Partial<RouteState>) => void;
}

export function useRouter(): Router {
  const [state, setState] = useState<RouteState>(() =>
    parse(window.location.pathname, window.location.search),
  );

  // A path with no matching route falls back to landing in `parse`, but the
  // address bar would still show the bogus path unless corrected here.
  useEffect(() => {
    const canonical = buildPath(state);
    if (canonical === "/" && window.location.pathname !== "/" && !KNOWN_PATHS.test(window.location.pathname)) {
      window.history.replaceState(null, "", "/");
    }
    // Runs once on mount only — this is a startup correction, not a sync loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPopState = () => setState(parse(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // `pushState`/`replaceState` run here, outside the `setState` call, quite
  // deliberately. React 18 StrictMode double-invokes functional setState
  // updaters in dev to catch exactly this class of bug: a side effect living
  // inside one silently ran twice, pushing every navigation as two identical
  // history entries. Back then had to be pressed twice per page, which reads
  // as "half-fixed" — worse than not fixing it, since it looks like it works
  // until it doesn't.
  const navigate = useCallback(
    (next: Partial<RouteState>) => {
      const merged = { ...state, ...next };
      window.history.pushState(null, "", buildPath(merged));
      setState(merged);
    },
    [state],
  );

  const replace = useCallback(
    (next: Partial<RouteState>) => {
      const merged = { ...state, ...next };
      window.history.replaceState(null, "", buildPath(merged));
      setState(merged);
    },
    [state],
  );

  return { ...state, navigate, replace };
}
