import { useCallback, useEffect, useRef, useState } from "react";
import { loadCache, saveCache } from "../lib/logCache";
import {
  mergeLogs,
  readSettlementLogs,
  type LogFamily,
  type SettlementLog,
} from "../lib/settlementEvents";
import { buildPipelines, type Pipelines } from "../lib/pipeline";
import { fetchBlockTimes } from "../lib/blockTime";
import type { LpEvent, Market } from "../lib/types";

/**
 * Watches Sepolia for settlement activity and keeps a fold of it current.
 *
 * Mounted only by the page that shows it, not by `App` — a visitor reading the
 * markets list should not be polling anything. Same reasoning as the comment on
 * `useNow`: a tick belongs to whoever needs it.
 */

const POLL_MS = 6_000;

/**
 * How far back each incremental read reaches.
 *
 * `logsInChunks` hands its upper bound to the serving node rather than naming a
 * block, deliberately — these RPCs sit behind a load balancer and a node that
 * is behind will reject a range that runs past its own head. So we cannot know
 * how far a scan actually got, and the cursor is a hint. This overlap is what
 * absorbs the error, and it has to be generous enough to cover a node that lags
 * by a few blocks, because such a node answers short rather than failing.
 */
const OVERLAP = 16n;

export interface SettlementFeed extends Pipelines {
  /** Head as of the last completed read. */
  head: bigint;
  /** Epoch ms of the last completed read, for showing the page is alive. */
  lastPollAt: number | null;
  failures: { family: LogFamily; message: string }[];
  loading: boolean;
}

export function useSettlementFeed(markets: Market[], lpEvents: LpEvent[]): SettlementFeed {
  const [logs, setLogs] = useState<SettlementLog[]>([]);
  const [head, setHead] = useState<bigint>(0n);
  const [lastPollAt, setLastPollAt] = useState<number | null>(null);
  const [failures, setFailures] = useState<{ family: LogFamily; message: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [times, setTimes] = useState<ReadonlyMap<bigint, number>>(new Map());

  /**
   * Held in a ref, not state: reading it must not re-arm the interval.
   *
   * Seeded from the previous visit. The cursor already skips ahead within a
   * session; without this it started from the deploy block on every reload,
   * which is a quarter of a million blocks of rescanning before anything
   * renders. See `logCache`.
   */
  const restored = useRef(loadCache());
  const store = useRef(
    mergeLogs(new Map<string, SettlementLog>(), restored.current?.logs ?? []),
  );
  const cursor = useRef<bigint | null>(restored.current?.cursor ?? null);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    // One read at a time. A slow response must not stack up behind the timer.
    if (busy.current) return;
    busy.current = true;
    try {
      const from = cursor.current;
      const scan = await readSettlementLogs(from === null ? {} : { from });

      // Union — see `mergeLogs` for the measurement that rules out replacing
      // the window, which would let a lagging node erase a settlement from the
      // screen and put the market back to "waiting".
      mergeLogs(store.current, scan.logs);

      const next = [...store.current.values()];
      setLogs(next);
      setHead(scan.head);
      setFailures(scan.failures);
      setLastPollAt(Date.now());

      // The cursor may only advance when nothing failed. A family that errored
      // has not been read for this window, and moving past it would lose those
      // logs permanently rather than retrying them.
      if (scan.failures.length === 0) {
        const maxSeen = next.reduce((m, l) => (l.blockNumber > m ? l.blockNumber : m), scan.head);
        const back = maxSeen > OVERLAP ? maxSeen - OVERLAP : 0n;
        cursor.current = back;
        // Persisted on the same condition as the cursor, and never otherwise:
        // storing a cursor past a family that failed would lose those logs for
        // every future visit rather than only this one.
        saveCache(back, next);
      }

      // Only blocks that will actually be rendered, newest first, capped.
      const wanted = next.flatMap((l) =>
        l.kind === "requested" || l.kind === "report" || l.kind === "settled"
          ? [l.blockNumber]
          : [],
      );
      setTimes(new Map(await fetchBlockTimes(wanted)));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      // A backgrounded tab stops reading, exactly as the spot poller does.
      if (document.hidden || stopped) return;
      void poll();
    };

    void poll();
    const timer = setInterval(tick, POLL_MS);

    // Catching up immediately on return is not needed for correctness — the
    // cursor does not move while hidden, so the next tick simply reads a wider
    // window — but a tab left in the background should not sit stale for six
    // seconds in front of an audience.
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  const pipelines = buildPipelines(markets, logs, lpEvents, new Map(times));

  return { ...pipelines, head, lastPollAt, failures, loading };
}
