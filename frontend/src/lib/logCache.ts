import {
  AMM_MARKET_ADDRESS,
  CRYPTO_MARKET_ADDRESS,
  DEPLOY_BLOCK,
  FLIGHT_MARKET_ADDRESS,
  RESERVE_MARKET_ADDRESS,
  STOCK_MARKET_ADDRESS,
} from "./config";
import type { SettlementLog } from "./settlementEvents";

/**
 * What a previous visit already read, so a reload does not read it again.
 *
 * The feed already scans incrementally WITHIN a session: it keeps a cursor and
 * only asks for blocks past it. What it could not do is remember that across a
 * reload, so every page load rescanned the whole chain from the deploy block —
 * measured 2026-09-19 as 249,093 blocks and 191 RPC requests before a single
 * number appeared on screen. The public node answered that with HTTP 429 and
 * the page rendered nothing at all.
 *
 * That is also why a paid endpoint did not fix it. Alchemy's free tier caps
 * `eth_getLogs` at a TEN block range, which is worse than the public node's
 * 10,000 for this shape of work. The binding constraint was never the request
 * rate; it was asking for a quarter of a million blocks in the first place.
 */

const VERSION = 1;

/**
 * Keyed by the contracts being watched, so pointing the app at a redeployed
 * address starts from nothing rather than serving the previous deployment's
 * logs under new ids.
 */
const KEY = [
  "predictsafe.logcache",
  VERSION,
  [
    FLIGHT_MARKET_ADDRESS,
    CRYPTO_MARKET_ADDRESS,
    STOCK_MARKET_ADDRESS,
    RESERVE_MARKET_ADDRESS,
    AMM_MARKET_ADDRESS,
  ]
    .join(",")
    .toLowerCase(),
].join(":");

export interface CachedScan {
  /** The cursor to resume from. Already includes the feed's overlap. */
  cursor: bigint;
  logs: SettlementLog[];
}

/** `JSON.stringify` cannot carry a bigint, and every block number is one. */
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}#bigint` : v);
const reviver = (_k: string, v: unknown) =>
  typeof v === "string" && v.endsWith("#bigint") ? BigInt(v.slice(0, -7)) : v;

/**
 * Reads what was stored, or null when there is nothing usable.
 *
 * Every failure path returns null rather than throwing: private windows, full
 * quotas and cleared site data are all ordinary, and a cache that cannot be
 * read must cost nothing more than the scan it was meant to save.
 */
export function loadCache(): CachedScan | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviver) as CachedScan;
    if (typeof parsed?.cursor !== "bigint" || !Array.isArray(parsed.logs)) return null;
    // A cursor before the deploy block saves nothing and hides a bug.
    if (parsed.cursor < DEPLOY_BLOCK) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCache(cursor: bigint, logs: SettlementLog[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cursor, logs }, replacer));
  } catch {
    // Quota, private mode, or storage disabled. The feed keeps working from
    // the network; it simply starts from the deploy block next time.
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — see saveCache.
  }
}
