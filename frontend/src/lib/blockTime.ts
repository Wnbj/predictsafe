import { publicClient } from "./chain";

/**
 * Where the cache is kept between visits.
 *
 * Not keyed by contract, unlike the log cache: a block's timestamp is a fact
 * about the chain rather than about this deployment, so pointing the app at
 * different addresses does not invalidate any of it.
 */
const STORAGE_KEY = "predictsafe.blocktimes:1";

/**
 * Wall-clock times for blocks, fetched lazily and cached forever.
 *
 * Nothing else in the app asks the chain what time it is — countdowns run off
 * the browser clock and prices carry their own timestamps. A settlement
 * timeline is the first thing that needs to say when something actually
 * happened, and the only honest source for that is the block itself.
 *
 * The cache never evicts because a mined block's timestamp cannot change. It
 * lives at module scope rather than in React state so it survives navigation:
 * leaving the page and coming back should not re-fetch two hundred blocks.
 */
const cache = new Map<bigint, number>(restore());

/**
 * A mined block's timestamp cannot change, so this is the one thing in the app
 * that is safe to trust from storage indefinitely. Without it a reload spends
 * a dozen polls re-asking for times it already knew — 8 per tick, against a
 * timeline that routinely shows a hundred blocks.
 *
 * Every failure path yields nothing rather than throwing: private windows,
 * full quotas and cleared site data are all ordinary.
 */
function restore(): [bigint, number][] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as [string, number][];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(([b, t]) =>
      typeof b === "string" && typeof t === "number" ? [[BigInt(b), t] as [bigint, number]] : [],
    );
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...cache].map(([b, t]) => [b.toString(), t])),
    );
  } catch {
    // Nothing to do — the times simply get fetched again next visit.
  }
}

/**
 * Add timestamps from the shipped log snapshot. Never overwrites: a mined
 * block's time cannot change, so whichever copy arrived first is right.
 */
export function seedBlockTimes(entries: Iterable<[bigint, number]>): void {
  let added = false;
  for (const [block, time] of entries) {
    if (!cache.has(block)) {
      cache.set(block, time);
      added = true;
    }
  }
  if (added) persist();
}

/** Blocks already known. Safe to read every render. */
export function knownBlockTimes(): ReadonlyMap<bigint, number> {
  return cache;
}

/**
 * Fill in timestamps for blocks that need them, newest first.
 *
 * Capped per call on purpose. A cold load with two hundred historical
 * settlements must not fire two hundred `eth_getBlockByNumber` calls at an RPC
 * this project already documents as flaky — the rows fill in over the next few
 * ticks instead, and a missing time renders as the block number rather than as
 * a guess.
 *
 * @returns the cache, so a caller can pass it straight to `buildPipelines`.
 */
export async function fetchBlockTimes(
  blocks: Iterable<bigint>,
  max = 8,
): Promise<ReadonlyMap<bigint, number>> {
  const missing = [...new Set(blocks)].filter((b) => !cache.has(b));
  if (missing.length === 0) return cache;

  // Newest first: the rows a viewer is looking at during a demo are the ones
  // that just happened.
  missing.sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));

  await Promise.all(
    missing.slice(0, max).map(async (blockNumber) => {
      try {
        const block = await publicClient.getBlock({ blockNumber });
        cache.set(blockNumber, Number(block.timestamp));
      } catch {
        // Decoration, not evidence. A block whose timestamp will not load just
        // shows as a block number, and the next tick tries again.
      }
    }),
  );

  persist();
  return cache;
}
