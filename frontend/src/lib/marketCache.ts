import { bigintReplacer, bigintReviver, CONTRACTS_FINGERPRINT } from "./logCache";
import type { Market } from "./types";

/**
 * The markets as the last visit read them, shown at once on the next while a
 * fresh read runs behind them.
 *
 * Unlike the log cache this holds DECODED objects — the app's own shape — so a
 * deploy that changes `Market` must never be fed last version's objects. The
 * key therefore includes `import.meta.url`: in a production build that is this
 * chunk's hashed URL, which changes with every build. In dev it is stable,
 * which is fine — a dev reload after a shape change is a cache miss away.
 */
const PREFIX = "predictsafe.markets";
const KEY = [PREFIX, 1, CONTRACTS_FINGERPRINT, import.meta.url].join(":");

/** Older than this is not worth showing even as a placeholder. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedMarkets {
  markets: Market[];
  savedAt: number;
}

export function loadCachedMarkets(now = Date.now()): CachedMarkets | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw, bigintReviver) as CachedMarkets;
    if (!Array.isArray(parsed.markets) || typeof parsed.savedAt !== "number") return null;
    if (now - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveMarkets(markets: Market[], now = Date.now()) {
  try {
    // Every build writes a new key; drop the ones it left behind.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== KEY) localStorage.removeItem(k);
    }
    localStorage.setItem(KEY, JSON.stringify({ markets, savedAt: now }, bigintReplacer));
  } catch {
    // Full or blocked storage costs the next visit its head start, nothing else.
  }
}
