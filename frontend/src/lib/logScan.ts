import { parseAbiItem, type Log } from "viem";
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
import { loadCache, saveCache } from "./logCache";
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

/**
 * Verified by hash against a real receipt rather than taken from documentation:
 * topic0 is 0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5.
 * The hash pins the TYPES only — the RUNBOOK calls the bool both `success` and
 * `result`, and nothing on chain settles which name is right. `result` is what
 * the upstream KeystoneForwarder declares.
 */
export const REPORT_PROCESSED_EVENT = parseAbiItem(
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
);

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
