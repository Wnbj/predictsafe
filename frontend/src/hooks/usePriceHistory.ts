import { useEffect, useState } from "react";
import type { Address } from "viem";
import { publicClient } from "../lib/chain";

export type RangeKey = "1H" | "4H" | "1D" | "1W" | "1M";

export const RANGE_SECONDS: Record<RangeKey, number> = {
  "1H": 3_600,
  "4H": 14_400,
  "1D": 86_400,
  "1W": 604_800,
  "1M": 2_592_000,
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Coinbase candle granularity, in seconds, chosen so a range stays under the 300-candle cap per request. */
const GRANULARITY: Record<RangeKey, number> = {
  "1H": 60,
  "4H": 300,
  "1D": 900,
  "1W": 3_600,
  "1M": 21_600,
};

/**
 * Real OHLC candles from Coinbase Exchange — the same endpoint the settlement
 * workflow reads, so this chart shows the kind of data the market actually
 * settles on, not a different, prettier source that happens to look similar.
 */
export function useCandleHistory(
  symbol: string | null,
  range: RangeKey,
): { candles: Candle[]; loading: boolean } {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setCandles([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    // A new symbol or range starts empty; a failed REFRESH of the same one
    // keeps what is on screen — it used to blank the chart on one bad poll.
    let first = true;

    const load = async () => {
      setLoading(true);
      try {
        const granularity = GRANULARITY[range];
        const end = Math.floor(Date.now() / 1000);
        const start = end - granularity * 280; // stays under Coinbase's 300-candle cap
        const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=${granularity}&start=${start}&end=${end}`;
        const r = await fetch(url, { signal: controller.signal });
        if (!r.ok) throw new Error(String(r.status));
        const raw = (await r.json()) as [number, number, number, number, number, number][];
        // Coinbase returns [time, low, high, open, close, volume], newest first.
        const cs = raw
          .map(([time, low, high, open, close]) => ({ time, open, high, low, close }))
          .sort((a, b) => a.time - b.time);
        if (!cancelled) setCandles(cs);
      } catch {
        // A missed fetch is not worth surfacing here — the previous candles
        // stay on screen and the next poll corrects it.
        if (!cancelled && first) setCandles([]);
      } finally {
        first = false;
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(t);
    };
  }, [symbol, range]);

  return { candles, loading };
}

const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** How many rounds back to fetch, regardless of range — filtered by time after. */
const ROUND_LOOKBACK = 60;

export interface FeedPoint {
  time: number;
  value: number;
}

/**
 * A Data Feed round is one answer, not a candle — there is no open/high/low
 * inside it, so this returns a point series to be drawn as a line rather than
 * inventing OHLC data nobody published. Round ids are assumed contiguous
 * within the lookback window, which holds unless the feed's phase changed
 * recently; a phase change simply makes older points fail and drop out.
 */
export function useFeedRoundHistory(
  feed: Address | null,
  range: RangeKey,
): { points: FeedPoint[]; loading: boolean } {
  const [points, setPoints] = useState<FeedPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!feed) {
      setPoints([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        // Feeds do not agree on scale: CSPX publishes 8 decimals, stETH
        // Proof of Reserves 18. Dividing everything by 1e8 plots a reserve
        // feed ten orders of magnitude off its real level.
        const [latest, decimals] = (await Promise.all([
          publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
          publicClient.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
        ])) as [readonly [bigint, bigint, bigint, bigint, bigint], number];
        const latestId = latest[0];
        const scale = 10 ** Number(decimals);

        const results = await publicClient.multicall({
          contracts: Array.from({ length: ROUND_LOOKBACK }, (_, i) => ({
            address: feed,
            abi: feedAbi,
            functionName: "getRoundData" as const,
            args: [latestId - BigInt(i)] as const,
          })),
          allowFailure: true,
        });

        const cutoff = Math.floor(Date.now() / 1000) - RANGE_SECONDS[range];
        const pts = results
          .filter((r) => r.status === "success")
          .map((r) => r.result as readonly [bigint, bigint, bigint, bigint, bigint])
          .filter((r) => r[3] > 0n) // updatedAt === 0 means the round was never published
          .map((r) => ({ time: Number(r[3]), value: Number(r[1]) / scale }))
          .filter((p) => p.time >= cutoff)
          .sort((a, b) => a.time - b.time);

        if (!cancelled) setPoints(pts);
      } catch {
        if (!cancelled) setPoints([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [feed, range]);

  return { points, loading };
}
