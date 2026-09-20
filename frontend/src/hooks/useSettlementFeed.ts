import { useCallback, useEffect, useRef, useState } from "react";
import {
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

  /** One read at a time: a slow response must not stack up behind the timer. */
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // `syncLogs` underneath owns the cursor, the union and the cache, and
      // shares one read with every other consumer on the page. This hook used
      // to own all three itself, which is how four hooks ended up starting
      // four separate walks of the chain.
      const scan = await readSettlementLogs();

      setLogs(scan.logs);
      setHead(scan.head);
      setFailures(scan.failures);
      setLastPollAt(Date.now());

      // Only blocks that will actually be rendered.
      const wanted = scan.logs.flatMap((l) =>
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
