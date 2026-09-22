import { type Log } from "viem";
import { REPORT_PROCESSED_EVENT } from "./forwarderEvent";
import {
  AMM_MARKET_ADDRESS,
  CRYPTO_MARKET_ADDRESS,
  DEPLOY_BLOCK,
  FLIGHT_MARKET_ADDRESS,
  KNOWN_FORWARDERS,
  RESERVE_MARKET_ADDRESS,
  STOCK_MARKET_ADDRESS,
} from "./config";
import { publicClient } from "./chain";
import {
  bigintReviver,
  CONTRACTS_FINGERPRINT,
  loadCache,
  saveCache,
} from "./logCache";
import { seedBlockTimes } from "./blockTime";
import type { CategoryId } from "./types";

/**
 * Every log this app reads, fetched once.
 *
 * WHY THIS MODULE EXISTS. The decoders used to fetch their own logs: nine
 * `getLogs` call sites in `settlementEvents.ts` and five in `chain.ts`, each
 * walking the chain in its own chunked loop. A cold load walked 256,812 blocks
 * in 10,000-block chunks — 26 chunks — and did it TWENTY times over, because
 * the markets page and the live feed each start their own set. Measured
 * 2026-09-20: about 520 `eth_getLogs` requests to render one page, and Infura
 * refused most of them.
 *
 * The count was never necessary. `eth_getLogs` takes an ARRAY of addresses,
 * and our five receivers emit nothing we do not want, so ONE query per chunk
 * returns everything and the decoders sort it out by topic0 afterwards. Two
 * queries, in fact: the forwarder logs come from different addresses and are
 * narrowed by an indexed argument, which is worth keeping — other people's
 * workflows share that forwarder, measured, so an unfiltered read would drag
 * their settlements back with ours.
 *
 * 26 chunks × 2 = 52 requests for a cold load, and 2 for a poll. The decoders
 * did not have to change shape for this; only who issues the query.
 */

// --- signatures -------------------------------------------------------------

export { REPORT_PROCESSED_EVENT } from "./forwarderEvent";

// --- which contract is which -----------------------------------------------

/**
 * Address is the ONLY safe discriminator.
 *
 * Crypto and AMM share topic0 on both `SettlementRequested` and `Settled`, so a
 * reader keyed on the event signature would merge two different markets that
 * happen to share a numeric id. This is the same trap the workflow avoids by
 * taking its receiver from `triggerEvent.address` rather than from config.
 */
export const CONTRACT_CATEGORY = new Map<string, CategoryId>([
  [FLIGHT_MARKET_ADDRESS.toLowerCase(), "flights"],
  [CRYPTO_MARKET_ADDRESS.toLowerCase(), "crypto"],
  [STOCK_MARKET_ADDRESS.toLowerCase(), "stocks"],
  [RESERVE_MARKET_ADDRESS.toLowerCase(), "reserves"],
  [AMM_MARKET_ADDRESS.toLowerCase(), "amm"],
]);

export const RECEIVER_ADDRESSES = [
  FLIGHT_MARKET_ADDRESS,
  CRYPTO_MARKET_ADDRESS,
  STOCK_MARKET_ADDRESS,
  RESERVE_MARKET_ADDRESS,
  AMM_MARKET_ADDRESS,
] as const;

/**
 * Two categories sharing an address would silently merge their markets, with no
 * type error and no runtime error — one bad paste in `.env.local` is enough.
 * Asserted at module load so it cannot be discovered from wrong numbers.
 */
if (CONTRACT_CATEGORY.size !== RECEIVER_ADDRESSES.length) {
  throw new Error(
    "Two market contracts share an address — check VITE_*_MARKET_ADDRESS. " +
      `Expected ${RECEIVER_ADDRESSES.length} distinct, got ${CONTRACT_CATEGORY.size}.`,
  );
}

export function categoryOf(address: string): CategoryId | null {
  return CONTRACT_CATEGORY.get(address.toLowerCase()) ?? null;
}

// --- walking ----------------------------------------------------------------

/**
 * Public RPCs cap getLogs spans, so walk the range in chunks.
 *
 * The final chunk asks for "latest" rather than the block number we just read.
 * These endpoints sit behind a load balancer: eth_blockNumber can be answered
 * by a node that is ahead of the one that then serves eth_getLogs, which
 * rejects the range as extending beyond its head. Letting the serving node
 * decide its own upper bound removes the mismatch entirely.
 */
export async function logsInChunks<T>(
  fetchRange: (from: bigint, to: bigint | "latest") => Promise<T[]>,
  fromBlock: bigint,
  latest: bigint,
): Promise<T[]> {
  /*
   * 10,000 is Infura's hard cap — it answers `range N exceeds limit of 10000`
   * above it, measured 2026-09-20. The public node accepted 45,000, which is
   * why this used to be larger; that endpoint is no longer reliable enough to
   * size against. Smaller chunks mean more requests, which is what the pacing
   * in `chain.ts` and the store below are for.
   */
  const STEP = 10_000n;
  const out: T[] = [];
  // A caller may hand us a cursor ahead of the head this node reports — the
  // same load-balancer skew described above, seen from the other side. One
  // chunk ending at "latest" is still correct and still returns nothing.
  const start = fromBlock > latest ? latest : fromBlock;
  for (let from = start; from <= latest; from += STEP) {
    const end = from + STEP - 1n;
    const reachesHead = end >= latest;
    out.push(...(await fetchRange(from, reachesHead ? "latest" : end)));
    if (reachesHead) break;
  }
  return out;
}

// --- the store --------------------------------------------------------------

export type RawLog = Log<bigint, number, false>;

export type LogSource = "receiver" | "forwarder";

export interface LogScan {
  /** Everything the five market contracts emitted. Undecoded. */
  receiver: RawLog[];
  /** `ReportProcessed`, already narrowed to reports aimed at our receivers. */
  forwarder: RawLog[];
  /** Head as this node reported it when the scan began. A hint, not a promise. */
  head: bigint;
  failures: { source: LogSource; message: string }[];
}

/**
 * How far back each incremental read reaches.
 *
 * `logsInChunks` hands its upper bound to the serving node rather than naming a
 * block, deliberately — see above. So we cannot know how far a scan actually
 * got, and the cursor is a hint. This overlap is what absorbs the error, and it
 * has to be generous enough to cover a node that lags by a few blocks, because
 * such a node answers short rather than failing.
 */
const OVERLAP = 16n;

const restored = loadCache();

/**
 * Keyed by `txHash:logIndex`, which is a log's identity on chain.
 *
 * A Map rather than an array because reads UNION rather than replace — see
 * `mergeLogs` in `settlementEvents.ts` for the measurement behind that, which
 * is about an endpoint answering identical queries differently rather than
 * about anything this module does.
 */
const receiverStore = new Map<string, RawLog>();
const forwarderStore = new Map<string, RawLog>();

const rawId = (l: RawLog) => `${l.transactionHash}:${l.logIndex}`;

const absorb = (store: Map<string, RawLog>, logs: RawLog[]) => {
  for (const l of logs) store.set(rawId(l), l);
};

absorb(receiverStore, restored?.receiver ?? []);
absorb(forwarderStore, restored?.forwarder ?? []);

/** Where the next read starts. Null means "from the deploy block". */
let cursor: bigint | null = restored?.cursor ?? null;

/**
 * The read in progress, if any.
 *
 * Four hooks ask for logs within a few milliseconds of each other on a cold
 * load — markets, trades, liquidity, the live feed. Without this they would
 * each start their own walk and the consolidation above would buy nothing.
 */
let inFlight: Promise<LogScan> | null = null;

// --- the shipped snapshot ---------------------------------------------------

/**
 * History the app ships with, so a first visit does not walk the chain.
 *
 * WHY. Everything before a recent block is immutable, yet a first visit —
 * nothing in localStorage — walked all of it: 28 chunks of 10,000 blocks, two
 * queries each, before a single settlement could be drawn. On the free RPC
 * that is where the rate limit bites. Measured 2026-09-22: a cold load of
 * `/live` drew 142 HTTP 429s in its first 171 requests, and for about two
 * minutes the page showed four red "could not be read" banners and "Settled 0"
 * before a retry got through. The same code had loaded cleanly the night
 * before; the difference was the endpoint's mood. On a demo, that is the first
 * impression.
 *
 * So `scripts/snapshot-logs.ts` runs the SAME `syncLogs` against the chain once,
 * and writes what it read to `public/`. A first visit seeds the store from that
 * and scans only the tail. Nothing is trusted that the chain did not say: the
 * file holds raw logs exactly as a node returned them, and the tail after it is
 * read live on every visit like any other poll.
 *
 * A snapshot that is out of date costs a longer tail, never a wrong answer. One
 * made for other contracts is refused by the fingerprint, as the cache is.
 */
export const SNAPSHOT_URL = "/logs-snapshot.json";
const SNAPSHOT_VERSION = 1;

export interface LogSnapshot {
  /** Highest block the snapshot vouches for. The live scan resumes before it. */
  head: bigint;
  receiver: RawLog[];
  forwarder: RawLog[];
  /** Timestamps for the blocks the pipeline renders, which cannot change. */
  blockTimes: [bigint, number][];
}

/**
 * Validate a snapshot file, or return null. Pure, so the refusals are testable.
 *
 * Every rejection is silent and total: a snapshot is an optimisation, and one
 * that is malformed, from another version, or made for other contracts must
 * cost exactly what not having it costs — a full scan — and nothing more.
 */
export function parseSnapshot(text: string, fingerprint = CONTRACTS_FINGERPRINT): LogSnapshot | null {
  try {
    const raw = JSON.parse(text, bigintReviver) as Record<string, unknown>;
    if (raw?.version !== SNAPSHOT_VERSION) return null;
    if (raw.contracts !== fingerprint) return null;
    if (typeof raw.head !== "bigint" || raw.head < DEPLOY_BLOCK) return null;
    if (!Array.isArray(raw.receiver) || !Array.isArray(raw.forwarder)) return null;
    const times = Array.isArray(raw.blockTimes) ? raw.blockTimes : [];
    return {
      head: raw.head,
      receiver: raw.receiver as RawLog[],
      forwarder: raw.forwarder as RawLog[],
      blockTimes: times.flatMap((e): [bigint, number][] =>
        Array.isArray(e) && typeof e[0] === "bigint" && typeof e[1] === "number" ? [[e[0], e[1]]] : [],
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Seed the store from the shipped snapshot, once, on a first visit.
 *
 * Only in a browser. The snapshot script runs this module under bun to PRODUCE
 * the file, and a snapshot built from the previous snapshot would be one that
 * nobody ever checked against the chain.
 */
async function seedFromSnapshot(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch(SNAPSHOT_URL);
    if (!res.ok) return;
    const snap = parseSnapshot(await res.text());
    if (!snap) return;
    absorb(receiverStore, snap.receiver);
    absorb(forwarderStore, snap.forwarder);
    seedBlockTimes(snap.blockTimes);
    cursor = snap.head > OVERLAP ? snap.head - OVERLAP : 0n;
  } catch {
    // Network error, missing file, bad JSON: fall through to a full scan.
  }
}

/** Only for tests: forget everything read so far. */
export function resetLogScan(): void {
  receiverStore.clear();
  forwarderStore.clear();
  cursor = null;
  inFlight = null;
}

function snapshot(head: bigint, failures: { source: LogSource; message: string }[]): LogScan {
  return {
    receiver: [...receiverStore.values()],
    forwarder: [...forwarderStore.values()],
    head,
    failures,
  };
}

/**
 * Read whatever is new and return everything known, decoded by nobody.
 *
 * Failures are per source and RETURNED, never swallowed — the same rule
 * `readMarkets` follows. A source that fails leaves its logs at whatever the
 * last successful read saw, and the cursor does not move past it, so the next
 * poll asks for the same range again rather than losing it permanently.
 */
export async function syncLogs(): Promise<LogScan> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // A first visit starts from the shipped snapshot rather than the deploy
    // block. Inside the shared promise, so four hooks asking at once load it
    // once.
    if (cursor === null) await seedFromSnapshot();
    const head = await publicClient.getBlockNumber();
    const from = cursor ?? DEPLOY_BLOCK;
    const failures: { source: LogSource; message: string }[] = [];

    const read = async (source: LogSource, fetch: () => Promise<RawLog[]>) => {
      try {
        return await fetch();
      } catch (e) {
        failures.push({ source, message: e instanceof Error ? e.message : String(e) });
        return null;
      }
    };

    const [receiver, forwarder] = await Promise.all([
      /*
       * No topic filter at all. Our five contracts emit nothing we are not
       * interested in, so filtering would only cost a longer request for the
       * same answer — and every filter is one more place for a new event to
       * go missing silently, which is how the AMM's trades stayed invisible
       * to the leaderboard for a week.
       */
      read("receiver", () =>
        logsInChunks(
          (fromBlock, toBlock) =>
            publicClient.getLogs({
              address: [...RECEIVER_ADDRESSES],
              fromBlock,
              toBlock,
            }) as Promise<RawLog[]>,
          from,
          head,
        ),
      ),
      /*
       * Narrowed by the indexed receiver rather than client-side: other
       * people's workflows share this forwarder — measured, not assumed — so
       * an unfiltered read would both cost more and mix their settlements
       * into ours.
       */
      read("forwarder", () =>
        logsInChunks(
          (fromBlock, toBlock) =>
            publicClient.getLogs({
              address: KNOWN_FORWARDERS,
              event: REPORT_PROCESSED_EVENT,
              args: { receiver: [...RECEIVER_ADDRESSES] },
              fromBlock,
              toBlock,
            }) as Promise<RawLog[]>,
          from,
          head,
        ),
      ),
    ]);

    if (receiver) absorb(receiverStore, receiver);
    if (forwarder) absorb(forwarderStore, forwarder);

    // The cursor may only advance when NOTHING failed. A source that errored
    // has not been read for this window, and moving past it would lose those
    // logs permanently rather than retrying them next poll.
    if (failures.length === 0) {
      cursor = head > OVERLAP ? head - OVERLAP : 0n;
      saveCache(cursor, [...receiverStore.values()], [...forwarderStore.values()]);
    }

    return snapshot(head, failures);
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
