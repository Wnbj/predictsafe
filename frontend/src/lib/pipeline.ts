import { orderLogs, type PayoutLog, type ReportLog, type RequestedLog, type SettledLog, type SettlementLog } from "./settlementEvents";
import { MarketStatus, type LpEvent, type Market } from "./types";

/**
 * Folding settlement logs into what actually happened to each market.
 *
 * THE STATE IS DERIVED FROM LOGS, NEVER FROM `market.status`. Two reasons, both
 * live: `AmmMarket.Status` has no `Locked`, so its numbers sit one below every
 * other contract's, and `Locked` is never assigned by any contract at all — a
 * status-driven state machine therefore has both a dead branch and an
 * off-by-one waiting in it. Logs have neither problem, and they also carry the
 * one thing status cannot: that a delivery was attempted and refused.
 */

export type PipelineState =
  /** Requested, nothing back yet. */
  | "in-flight"
  /** The forwarder recorded a refused delivery and the market never settled. */
  | "rejected"
  /** Delivered, accepted, written. A void outcome is still a settlement. */
  | "settled"
  /** Settled, but no forwarder log in range — absence of evidence, not failure. */
  | "settled-unattested"
  /**
   * Void on chain with nothing in the logs to explain it.
   *
   * `ownerVoid` — the POC escape hatch on every market contract — writes
   * `Status.Void` and emits NOTHING. A log-derived pipeline therefore cannot
   * see it, and an attempt cleared that way would otherwise sit at the top of
   * the page reading "waiting for a report" for ever, which is the one thing
   * this page must not do: claim something is in progress when it is over.
   *
   * This is the single place state is read from `market.status` rather than
   * from logs, and it is deliberately narrow — only to move an attempt OUT of
   * flight, never to declare how it resolved. The status enum is trustworthy
   * here because `readAmmMarkets` normalises the AMM's offset numbering at the
   * read boundary; it was not when this module was written.
   */
  | "abandoned"
  /** Settled and at least some money has left. */
  | "paid";

/**
 * A refused report that names no market, and why it could not be placed.
 *
 * `duplicate` — nothing on that contract was awaiting settlement when the
 * report arrived, so it was a re-delivery of something already decided. The
 * cron sweeps produce these on purpose: they re-settle inside the finality
 * window and the contract rejects the second attempt. Ordinary, not an alarm.
 *
 * `ambiguous` — two or more markets on that contract WERE awaiting settlement,
 * and a refused report carries no market id. One of them failed and the chain
 * does not say which. That is worth someone's attention, and saying which one
 * would be inventing a fact.
 */
export interface UnattributedReport {
  report: ReportLog;
  reason: "duplicate" | "ambiguous";
  /** Attempts open on that contract at that block. 0 for a duplicate. */
  openAtBlock: number;
}

export interface Attempt {
  /** `${marketKey}#${n}` — a market can be attempted more than once. */
  id: string;
  marketKey: string;
  /** Null when the market's own category failed to load. The row still shows. */
  market: Market | null;
  requested: RequestedLog | null;
  report: ReportLog | null;
  settled: SettledLog | null;
  payouts: PayoutLog[];
  state: PipelineState;
  /** First block of the attempt, for sorting. */
  startedAt: bigint;
  blocksToReport: number | null;
  /** Only when both block timestamps are known. Never derived from height. */
  secondsToReport: number | null;
}

export interface Pipelines {
  attempts: Attempt[];
  /**
   * Refused reports that could not be tied to one market.
   *
   * A refused report names a receiver contract and nothing else — no market id
   * — so unless exactly one market on that contract was awaiting settlement,
   * the chain genuinely does not say which one it was. Guessing would present
   * an inference as a fact, and with a five-rung ladder settled in sequence the
   * ambiguous case is ordinary rather than exotic.
   */
  unattributed: UnattributedReport[];
}

const isRequested = (l: SettlementLog): l is RequestedLog => l.kind === "requested";
const isReport = (l: SettlementLog): l is ReportLog => l.kind === "report";
const isSettled = (l: SettlementLog): l is SettledLog => l.kind === "settled";
const isPayout = (l: SettlementLog): l is PayoutLog => l.kind === "payout";

/**
 * @param blockTimes unix seconds per block, as far as they are known. Gaps are
 *                   expected — timestamps are fetched lazily and a missing one
 *                   means "not looked up yet", never "instant".
 */
export function buildPipelines(
  markets: Market[],
  logs: SettlementLog[],
  lpWithdrawals: LpEvent[] = [],
  blockTimes: Map<bigint, number> = new Map(),
): Pipelines {
  const marketByKey = new Map(markets.map((m) => [m.key, m]));

  // Deduped first: the live feed rescans an overlapping window every tick, so
  // the same log arrives repeatedly and must fold to the same result.
  const seen = new Set<string>();
  const ordered: SettlementLog[] = [];
  for (const l of [...logs].sort(orderLogs)) {
    const id = `${l.txHash}:${l.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(l);
  }

  /**
   * Attempts per market, split at each request. A market that was refused and
   * then requested again has two attempts, and collapsing them would hide the
   * refusal — which is the one thing here worth seeing.
   */
  const byMarket = new Map<string, Attempt[]>();
  const attemptsInOrder: Attempt[] = [];

  const newAttempt = (marketKey: string, startedAt: bigint): Attempt => {
    const list = byMarket.get(marketKey) ?? [];
    const attempt: Attempt = {
      id: `${marketKey}#${list.length}`,
      marketKey,
      market: marketByKey.get(marketKey) ?? null,
      requested: null,
      report: null,
      settled: null,
      payouts: [],
      state: "in-flight",
      startedAt,
      blocksToReport: null,
      secondsToReport: null,
    };
    list.push(attempt);
    byMarket.set(marketKey, list);
    attemptsInOrder.push(attempt);
    return attempt;
  };

  const openAttempt = (marketKey: string, at: bigint): Attempt => {
    const list = byMarket.get(marketKey);
    const last = list?.[list.length - 1];
    // A settled attempt is closed; anything after it belongs to a new one.
    if (last && !last.settled) return last;
    return newAttempt(marketKey, at);
  };

  for (const log of ordered) {
    if (isRequested(log)) {
      const attempt = newAttempt(log.marketKey, log.blockNumber);
      attempt.requested = log;
      continue;
    }
    if (isSettled(log)) {
      const attempt = openAttempt(log.marketKey, log.blockNumber);
      attempt.settled = log;
      continue;
    }
    if (isPayout(log)) {
      const list = byMarket.get(log.marketKey);
      // Payouts belong to whichever attempt actually settled the market.
      const target = list?.filter((a) => a.settled).pop() ?? list?.[list.length - 1];
      if (target) target.payouts.push(log);
      continue;
    }
  }

  // --- reports, last, because attribution depends on the rest --------------

  const unattributed: UnattributedReport[] = [];
  const settledByTx = new Map<`0x${string}`, SettledLog[]>();
  for (const l of ordered) {
    if (!isSettled(l)) continue;
    const list = settledByTx.get(l.txHash) ?? [];
    list.push(l);
    settledByTx.set(l.txHash, list);
  }

  for (const report of ordered.filter(isReport)) {
    /**
     * Accepted: the `Settled` in the SAME transaction names the market. Exact,
     * and the only association the chain actually provides.
     */
    const inTx = settledByTx.get(report.txHash) ?? [];
    if (inTx.length > 0) {
      for (const s of inTx) {
        const list = byMarket.get(s.marketKey);
        const target = list?.find((a) => a.settled === s);
        if (target) target.report = report;
      }
      continue;
    }

    /**
     * Accepted, but its `Settled` is not in hand yet.
     *
     * Not listed, because it is not a loose end: an accepted report means
     * `_processReport` ran, and that always emits `Settled` in the same
     * transaction. So the settlement exists and simply has not been read —
     * this endpoint answers identical queries with different numbers of logs
     * (see `mergeLogs`), and the union will pair them on a later poll.
     *
     * Listing it would put a permanent "unexplained" entry on screen for
     * something that resolves itself within seconds.
     */
    if (report.accepted) continue;

    /**
     * Refused. The only handle is (receiver contract, block), so the question
     * is how many markets on that contract were AWAITING settlement when it
     * landed — a market already settled by then cannot be the one that failed.
     *
     * Nothing is attached on a guess. An earlier version fell back to "the most
     * recent candidate", which quietly pinned sweep duplicates onto markets
     * that had settled and been paid out days before, and then hid them because
     * a paid attempt outranks a refusal when the state is computed.
     */
    if (report.category === null) {
      unattributed.push({ report, reason: "ambiguous", openAtBlock: 0 });
      continue;
    }
    const open = attemptsInOrder.filter(
      (a) =>
        a.marketKey.startsWith(`${report.category}:`) &&
        a.startedAt <= report.blockNumber &&
        !a.report &&
        (a.settled === null || a.settled.blockNumber > report.blockNumber),
    );

    if (open.length === 1) {
      open[0]!.report = report;
    } else {
      unattributed.push({
        report,
        reason: open.length === 0 ? "duplicate" : "ambiguous",
        openAtBlock: open.length,
      });
    }
  }

  // --- liquidity withdrawals count as payouts too --------------------------

  for (const w of lpWithdrawals) {
    if (w.direction !== "withdraw") continue;
    const list = byMarket.get(w.marketKey);
    const target = list?.filter((a) => a.settled).pop();
    if (!target) continue;
    target.payouts.push({
      kind: "payout",
      marketKey: w.marketKey,
      who: w.provider,
      amount: w.amount,
      via: "redeem",
      blockNumber: w.blockNumber,
      txHash: w.txHash,
      logIndex: -1,
    });
  }

  // --- final state ---------------------------------------------------------

  for (const a of attemptsInOrder) {
    a.state = stateOf(a);

    const from = a.requested?.blockNumber;
    const to = a.report?.blockNumber ?? a.settled?.blockNumber;
    if (from !== undefined && to !== undefined) {
      a.blocksToReport = Number(to - from);
      const t0 = blockTimes.get(from);
      const t1 = blockTimes.get(to);
      // Never blocks × 12s. An unknown timestamp stays unknown.
      a.secondsToReport = t0 !== undefined && t1 !== undefined ? t1 - t0 : null;
    }
  }

  return {
    attempts: attemptsInOrder.sort((x, y) => (x.startedAt === y.startedAt ? 0 : x.startedAt < y.startedAt ? -1 : 1)),
    unattributed,
  };
}

function stateOf(a: Attempt): PipelineState {
  // A refusal outranks everything. Attribution above only ever attaches a
  // refused report to an attempt that was genuinely open at the time, so if one
  // is here the market did not settle from it — and burying that under a later
  // status is the exact failure this module exists to prevent.
  if (a.report && !a.report.accepted) return "rejected";
  if (a.settled) {
    if (a.payouts.length > 0) return "paid";
    if (!a.report) return "settled-unattested";
    return "settled";
  }
  // Nothing settled it — but it is not waiting either. See "abandoned".
  if (a.market?.status === MarketStatus.Void) return "abandoned";
  return "in-flight";
}

/** Attempts still waiting or refused — what the top of the page shows. */
export function inFlight(p: Pipelines): Attempt[] {
  return p.attempts.filter((a) => a.state === "in-flight" || a.state === "rejected");
}

/** Everything resolved, newest first. */
export function history(p: Pipelines): Attempt[] {
  return p.attempts
    .filter((a) => a.state !== "in-flight" && a.state !== "rejected")
    .sort((x, y) => (y.startedAt === x.startedAt ? 0 : y.startedAt > x.startedAt ? 1 : -1));
}
