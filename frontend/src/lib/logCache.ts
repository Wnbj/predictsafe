import {
  AMM_MARKET_ADDRESS,
  CRYPTO_MARKET_ADDRESS,
  DEPLOY_BLOCK,
  FLIGHT_MARKET_ADDRESS,
  RESERVE_MARKET_ADDRESS,
  STOCK_MARKET_ADDRESS,
} from "./config";
import type { RawLog } from "./logScan";

/**
 * What a previous visit already read, so a reload does not read it again.
 *
 * `logScan` scans incrementally WITHIN a session: it keeps a cursor and only
 * asks for blocks past it. What it could not do is remember that across a
 * reload, so every page load rescanned the whole chain from the deploy block —
 * 256,812 blocks as of 2026-09-20, against an endpoint that answers HTTP 429
 * long before that finishes.
 *
 * UNDECODED logs are stored, not the decoded families. Two reasons. A decoded
 * shape is this app's opinion about the chain and changes whenever a decoder
 * does, which would silently serve last week's interpretation from cache; the
 * raw log is what the node said. And the decoders each want a different slice
 * of the same logs, so one cache under them serves all of them at once.
 */

/** Bumped whenever the stored shape changes. v2 holds raw logs, not decoded. */
const VERSION = 2;

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
  /** The cursor to resume from. Already includes the scan's overlap. */
  cursor: bigint;
  receiver: RawLog[];
  forwarder: RawLog[];
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
    if (typeof parsed?.cursor !== "bigint") return null;
    if (!Array.isArray(parsed.receiver) || !Array.isArray(parsed.forwarder)) return null;
    // A cursor before the deploy block saves nothing and hides a bug.
    if (parsed.cursor < DEPLOY_BLOCK) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCache(cursor: bigint, receiver: RawLog[], forwarder: RawLog[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cursor, receiver, forwarder }, replacer));
  } catch {
    // Quota, private mode, or storage disabled. The scan keeps working from
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
