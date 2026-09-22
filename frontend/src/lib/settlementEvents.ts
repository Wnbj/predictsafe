import { parseAbiItem, parseEventLogs, type AbiEvent } from "viem";
import { marketKey } from "./chain";
import { REPORT_PROCESSED_EVENT } from "./forwarderEvent";
import { categoryOf, syncLogs, type LogSource, type RawLog } from "./logScan";
import type { CategoryId } from "./types";

export { categoryOf, CONTRACT_CATEGORY, RECEIVER_ADDRESSES } from "./logScan";
export { REPORT_PROCESSED_EVENT } from "./forwarderEvent";

/**
 * Every log a settlement leaves behind, decoded in one place.
 *
 * WHAT A SETTLEMENT ACTUALLY LOOKS LIKE ON CHAIN, which is what this module
 * exists to make readable:
 *
 *   SettlementRequested          the market is handed to the oracle
 *        ↓  (an unobservable gap — see below)
 *   one transaction containing
 *     ReportProcessed            the forwarder's verdict on delivery
 *     Settled                    ONLY IF the receiver accepted it
 *        ↓
 *   Claimed / Redeemed           money leaving
 *
 * The gap is genuinely empty. The workflow reconciles three venues to a median
 * and discards them, and hashes an evidence document it never publishes, so
 * nothing between request and report reaches the chain at all.
 *
 * THE ONE THAT MATTERS: a rejected report leaves NO trace on the receiver.
 * `ReceiverTemplate.onReport` reverts before `_processReport` runs, so there is
 * no `Settled`, no revert visible to a log reader, nothing. The forwarder's
 * `ReportProcessed(..., false)` is the only evidence that a delivery was even
 * attempted. Reading it is the difference between showing a failure and showing
 * a market that merely looks slow.
 */

// --- signatures -------------------------------------------------------------

/** Crypto and AMM are byte-identical here — deliberately. Address discriminates. */
const CRYPTO_REQUESTED_EVENT = parseAbiItem(
  "event SettlementRequested(uint256 indexed marketId, uint8 asset, uint64 strikePrice, uint64 expiryTime)",
);
const FLIGHT_REQUESTED_EVENT = parseAbiItem(
  "event SettlementRequested(uint256 indexed marketId, string flightIata, uint32 departureDate, uint16 thresholdMinutes)",
);
const STOCK_REQUESTED_EVENT = parseAbiItem(
  "event SettlementRequested(uint256 indexed marketId, address feed, uint64 strikePrice, uint64 closeTime, uint64 expiryTime, uint32 maxStaleness)",
);
/** No closeTime — reserves deliberately do not get the movement check. */
const RESERVE_REQUESTED_EVENT = parseAbiItem(
  "event SettlementRequested(uint256 indexed marketId, address feed, uint64 strikePrice, uint64 expiryTime, uint32 maxStaleness)",
);

const CRYPTO_SETTLED_EVENT = parseAbiItem(
  "event Settled(uint256 indexed marketId, uint8 outcome, int256 observedValue, bytes32 evidenceHash)",
);
/** FlightMarket predates the shared base and still declares int32. */
const FLIGHT_SETTLED_EVENT = parseAbiItem(
  "event Settled(uint256 indexed marketId, uint8 outcome, int32 observedDelay, bytes32 evidenceHash)",
);

const CLAIMED_EVENT = parseAbiItem(
  "event Claimed(uint256 indexed marketId, address indexed user, uint256 amount)",
);
/** The AMM pays out through `redeem`, not `claim`. Distinct topic0. */
const REDEEMED_EVENT = parseAbiItem(
  "event Redeemed(uint256 indexed marketId, address indexed holder, uint256 amount)",
);

export const SETTLEMENT_EVENTS = {
  reportProcessed: REPORT_PROCESSED_EVENT,
  cryptoRequested: CRYPTO_REQUESTED_EVENT,
  flightRequested: FLIGHT_REQUESTED_EVENT,
  stockRequested: STOCK_REQUESTED_EVENT,
  reserveRequested: RESERVE_REQUESTED_EVENT,
  cryptoSettled: CRYPTO_SETTLED_EVENT,
  flightSettled: FLIGHT_SETTLED_EVENT,
  claimed: CLAIMED_EVENT,
  redeemed: REDEEMED_EVENT,
} as const;

// --- decoded shapes ---------------------------------------------------------

interface LogBase {
  blockNumber: bigint;
  txHash: `0x${string}`;
  /** Half of the dedupe key — a transaction can carry several of these. */
  logIndex: number;
}

export interface RequestedLog extends LogBase {
  kind: "requested";
  marketKey: string;
  /**
   * The terms as the ORACLE received them, not as `markets()` reports them now.
   * Reading them off the event is what makes the row honest: it shows what was
   * actually handed over, which is the thing that determines the answer.
   */
  terms: { label: string; value: string }[];
}

export interface ReportLog extends LogBase {
  kind: "report";
  /** The contract the report was delivered to. It carries no market id. */
  receiver: `0x${string}`;
  category: CategoryId | null;
  accepted: boolean;
  /**
   * The forwarder that emitted this — how the report was attested follows from
   * it, so it travels with the log rather than being read off config later.
   */
  forwarder: `0x${string}`;
  workflowExecutionId: `0x${string}`;
  reportId: `0x${string}`;
}

export interface SettledLog extends LogBase {
  kind: "settled";
  marketKey: string;
  outcome: number;
  observedValue: bigint;
  evidenceHash: `0x${string}`;
}

export interface PayoutLog extends LogBase {
  kind: "payout";
  marketKey: string;
  who: `0x${string}`;
  amount: bigint;
  /** `redeem` on the AMM, `claim` everywhere else. */
  via: "claim" | "redeem";
}

export type SettlementLog = RequestedLog | ReportLog | SettledLog | PayoutLog;

export type LogFamily = "requested" | "report" | "settled" | "payout";

export interface SettlementScan {
  logs: SettlementLog[];
  /** Head as this node reported it when the scan began. A hint, not a promise. */
  head: bigint;
  failures: { family: LogFamily; message: string }[];
}

// --- reading ----------------------------------------------------------------

const keyFor = (address: string, marketId: bigint): string | null => {
  const category = categoryOf(address);
  return category === null ? null : marketKey(category, Number(marketId));
};

/** Every family a failed source takes down with it. */
const FAMILIES_BY_SOURCE: Record<LogSource, LogFamily[]> = {
  receiver: ["requested", "settled", "payout"],
  forwarder: ["report"],
};

/** Narrow a pile of raw logs to one event, by topic0. */
const only = <const T extends AbiEvent>(logs: RawLog[], event: T) =>
  parseEventLogs({ abi: [event], logs });

/**
 * Decode every settlement log the scan has seen.
 *
 * It no longer fetches: `syncLogs` reads the chain ONCE for the whole app and
 * everything here is topic0 arithmetic over what came back. That is the
 * difference between nine walks of a quarter of a million blocks and none.
 *
 * Failures are per family and RETURNED, never swallowed — the same rule
 * `readMarkets` follows. A family that fails leaves its logs absent, and a
 * caller that quietly rendered a shorter pipeline would be claiming the chain
 * said something it did not. They are reported per FAMILY rather than per
 * source because that is the shape the page explains to a reader: "report logs
 * could not be read" means something to somebody looking at a pipeline, and
 * "the receiver query failed" does not.
 */
export async function readSettlementLogs(
  opts: { families?: LogFamily[] } = {},
): Promise<SettlementScan> {
  const wanted = opts.families;
  const scan = await syncLogs();

  const failures = scan.failures.flatMap(({ source, message }) =>
    FAMILIES_BY_SOURCE[source]
      .filter((family) => !wanted || wanted.includes(family))
      .map((family) => ({ family, message })),
  );

  const want = (family: LogFamily) => !wanted || wanted.includes(family);
  const failed = new Set(failures.map((f) => f.family));
  const on = (family: LogFamily) => want(family) && !failed.has(family);

  const raw = scan.receiver;
  const logs: SettlementLog[] = [];

  if (on("requested")) {
    for (const l of only(raw, CRYPTO_REQUESTED_EVENT)) {
      const key = keyFor(l.address, l.args.marketId);
      if (!key) continue;
      logs.push({
        kind: "requested",
        marketKey: key,
        terms: [
          { label: "Asset", value: Number(l.args.asset) === 1 ? "ETH" : "BTC" },
          { label: "Strike", value: l.args.strikePrice.toString() },
          { label: "Expiry", value: l.args.expiryTime.toString() },
        ],
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    for (const l of only(raw, FLIGHT_REQUESTED_EVENT)) {
      logs.push({
        kind: "requested",
        marketKey: marketKey("flights", Number(l.args.marketId)),
        terms: [
          { label: "Flight", value: l.args.flightIata },
          { label: "Date", value: String(l.args.departureDate) },
          { label: "Threshold", value: `${l.args.thresholdMinutes} min` },
        ],
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    for (const l of only(raw, STOCK_REQUESTED_EVENT)) {
      logs.push({
        kind: "requested",
        marketKey: marketKey("stocks", Number(l.args.marketId)),
        terms: [
          { label: "Feed", value: l.args.feed },
          { label: "Strike", value: l.args.strikePrice.toString() },
          { label: "Expiry", value: l.args.expiryTime.toString() },
        ],
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    for (const l of only(raw, RESERVE_REQUESTED_EVENT)) {
      logs.push({
        kind: "requested",
        marketKey: marketKey("reserves", Number(l.args.marketId)),
        terms: [
          { label: "Feed", value: l.args.feed },
          { label: "Strike", value: l.args.strikePrice.toString() },
          { label: "Expiry", value: l.args.expiryTime.toString() },
        ],
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
  }

  if (on("report")) {
    for (const l of only(scan.forwarder, REPORT_PROCESSED_EVENT)) {
      logs.push({
        kind: "report",
        receiver: l.args.receiver,
        category: categoryOf(l.args.receiver),
        accepted: l.args.result,
        forwarder: l.address,
        workflowExecutionId: l.args.workflowExecutionId,
        reportId: l.args.reportId,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
  }

  if (on("settled")) {
    for (const l of only(raw, CRYPTO_SETTLED_EVENT)) {
      const key = keyFor(l.address, l.args.marketId);
      if (!key) continue;
      logs.push({
        kind: "settled",
        marketKey: key,
        outcome: Number(l.args.outcome),
        observedValue: l.args.observedValue,
        evidenceHash: l.args.evidenceHash,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    for (const l of only(raw, FLIGHT_SETTLED_EVENT)) {
      logs.push({
        kind: "settled",
        marketKey: marketKey("flights", Number(l.args.marketId)),
        outcome: Number(l.args.outcome),
        // Widened at the decode boundary so the fold sees one shape. An early
        // arrival is a negative delay and must survive as one.
        observedValue: BigInt(l.args.observedDelay),
        evidenceHash: l.args.evidenceHash,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
  }

  if (on("payout")) {
    for (const l of only(raw, CLAIMED_EVENT)) {
      const key = keyFor(l.address, l.args.marketId);
      if (!key) continue;
      logs.push({
        kind: "payout",
        marketKey: key,
        who: l.args.user,
        amount: l.args.amount,
        via: "claim",
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    for (const l of only(raw, REDEEMED_EVENT)) {
      logs.push({
        kind: "payout",
        marketKey: marketKey("amm", Number(l.args.marketId)),
        who: l.args.holder,
        amount: l.args.amount,
        via: "redeem",
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
  }

  return { logs: logs.sort(orderLogs), head: scan.head, failures };
}

/** Chain order: block, then position within the block. */
export function orderLogs(a: SettlementLog, b: SettlementLog): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/** The dedupe identity of a log. A transaction carries several. */
export const logId = (l: SettlementLog) => `${l.txHash}:${l.logIndex}`;

/**
 * Fold a fresh scan into what is already known, by union.
 *
 * WHY UNION AND NOT REPLACE-THE-WINDOW, which is the obvious way to make a
 * reorg self-correcting: **this endpoint answers identical queries with
 * different results.** Measured, four full scans back to back, no errors
 * reported by any of them:
 *
 *     settled   23 · 27 · 27 · 27
 *     requested 28 · 24 · 24 · 28
 *     report    39 · 39 · 33 · 39
 *
 * The short answers are always missing the most RECENT logs, which is the other
 * face of asking for `"latest"`: the upper bound is resolved by whichever
 * load-balanced node serves the call, and one that lags simply has fewer blocks
 * to report. It does not error, because from its own point of view it answered
 * completely.
 *
 * Deleting a window on the strength of that would make a settled market flicker
 * back to "waiting for a report" whenever a lagging node answered — during a
 * demo, on the one screen whose whole job is to be believed. A union cannot do
 * that. What it gives up is automatic reorg correction, which at this depth is
 * a far rarer event than the lag that is provably happening right now, and a
 * page reload resolves it.
 */
export function mergeLogs(
  known: Map<string, SettlementLog>,
  incoming: SettlementLog[],
): Map<string, SettlementLog> {
  for (const l of incoming) known.set(logId(l), l);
  return known;
}
