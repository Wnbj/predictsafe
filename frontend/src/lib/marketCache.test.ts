import { beforeEach, describe, expect, it } from "vitest";
import { amm0, crypto0, flight0 } from "./fixtures";
import { loadCachedMarkets, saveMarkets } from "./marketCache";

/**
 * The returning visitor's head start. What matters: a market comes back
 * exactly as it went in — bigints included, since every pool and strike is
 * one — and nothing stale or left over from an older build is ever served.
 */

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe("market cache", () => {
  it("round-trips markets, bigints included", () => {
    saveMarkets([flight0, crypto0, amm0], 1_000);
    const got = loadCachedMarkets(2_000);
    expect(got?.savedAt).toBe(1_000);
    expect(got?.markets).toEqual([flight0, crypto0, amm0]);
  });

  it("is empty before anything was saved", () => {
    expect(loadCachedMarkets()).toBeNull();
  });

  it("serves nothing older than a week", () => {
    saveMarkets([flight0], 0);
    expect(loadCachedMarkets(7 * 24 * 3600 * 1000 + 1)).toBeNull();
  });

  /** Each build writes under a new key; the old ones must not pile up. */
  it("drops entries other builds left behind, and nothing else", () => {
    localStorage.setItem("predictsafe.markets:1:old-build", "{}");
    localStorage.setItem("predictsafe.logcache:2:x", "keep");
    saveMarkets([flight0], 1);
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys.filter((k) => k?.startsWith("predictsafe.markets"))).toHaveLength(1);
    expect(localStorage.getItem("predictsafe.logcache:2:x")).toBe("keep");
  });

  it("treats a corrupt entry as a miss, not an error", () => {
    saveMarkets([flight0], 1);
    const key = localStorage.key(0)!;
    localStorage.setItem(key, "{not json");
    expect(loadCachedMarkets(2)).toBeNull();
  });
});
