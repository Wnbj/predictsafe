import { describe, expect, it } from "vitest";
import { buildPipelines, history, inFlight } from "./pipeline";
import type {
  PayoutLog,
  ReportLog,
  RequestedLog,
  SettledLog,
  SettlementLog,
} from "./settlementEvents";
import { MarketStatus, Outcome, type LpEvent, type Market } from "./types";
import { amm0, crypto0, flight0 } from "./fixtures";
import { CRYPTO_MARKET_ADDRESS, AMM_MARKET_ADDRESS,
  attestationFor,
  DON_FORWARDER,
  MOCK_FORWARDER,
} from "./config";

/**
 * Folding settlement logs into what happened.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT: a refused delivery rendered as an
 * empty gap. When a report is rejected the receiver reverts inside `onReport`
 * and emits nothing at all — no `Settled`, no visible revert. The forwarder's
 * `ReportProcessed(..., false)` is the only evidence the delivery even
 * happened. Drop it from the fold and the page shows a market that merely looks
 * slow, which is precisely the silent failure this project is built to make
 * loud.
 *
 * The second trap is quieter: crypto and AMM emit byte-identical
 * `SettlementRequested` and `Settled`, so anything keyed on the event signature
 * rather than the contract address merges two different markets that happen to
 * share a numeric id.
 */

let seq = 0;
const tx = () => `0x${(++seq).toString(16).padStart(64, "0")}` as `0x${string}`;

const requested = (marketKey: string, block: bigint, txHash = tx()): RequestedLog => ({
  kind: "requested",
  marketKey,
  terms: [],
  blockNumber: block,
  txHash,
  logIndex: 0,
});

const report = (
  receiver: `0x${string}`,
  category: "crypto" | "amm" | "flights" | null,
  accepted: boolean,
  block: bigint,
  txHash = tx(),
  forwarder: `0x${string}` = MOCK_FORWARDER as `0x${string}`,
): ReportLog => ({
  kind: "report",
  receiver,
  category,
  accepted,
  forwarder,
  workflowExecutionId: `0x${"1".repeat(64)}`,
  reportId: "0x0001",
  blockNumber: block,
  txHash,
  logIndex: 0,
});

const settled = (
  marketKey: string,
  block: bigint,
  txHash: `0x${string}`,
  outcome = Outcome.Yes,
  observedValue = 6_300_000_000_000n,
): SettledLog => ({
  kind: "settled",
  marketKey,
  outcome,
  observedValue,
  evidenceHash: `0x${"e".repeat(64)}`,
  blockNumber: block,
  txHash,
  logIndex: 1,
});

const payout = (marketKey: string, block: bigint, via: "claim" | "redeem"): PayoutLog => ({
  kind: "payout",
  marketKey,
  who: "0x00000000000000000000000000000000000a11ce",
  amount: 1_000_000n,
  via,
  blockNumber: block,
  txHash: tx(),
  logIndex: 0,
});

const markets: Market[] = [crypto0, amm0, flight0];
const build = (logs: SettlementLog[], lp: LpEvent[] = [], times = new Map<bigint, number>()) =>
  buildPipelines(markets, logs, lp, times);

describe("buildPipelines", () => {
  it("shows a request with nothing back yet as in flight", () => {
    const { attempts } = build([requested(crypto0.key, 100n)]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("in-flight");
    expect(attempts[0]!.report).toBeNull();
    expect(attempts[0]!.settled).toBeNull();
  });

  it("pairs an accepted report with the settlement in its own transaction", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
      settled(crypto0.key, 114n, t),
    ]);

    expect(attempts[0]!.state).toBe("settled");
    expect(attempts[0]!.report?.accepted).toBe(true);
    expect(attempts[0]!.blocksToReport).toBe(14);
  });

  /**
   * The reason this module exists. Without the forwarder log there is nothing
   * at all to show, and the market looks like it is still being worked on.
   */
  /**
   * A migration to a real DON is not a switchover — the mock keeps delivering
   * whatever was already in flight while new reports arrive from the
   * production forwarder. The feed has to show both, and describe each by the
   * forwarder that actually delivered it rather than by one global setting.
   */
  it("keeps two forwarders apart, and lets each describe itself", () => {
    const a = tx();
    const b = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, a, MOCK_FORWARDER as `0x${string}`),
      settled(crypto0.key, 114n, a),
      requested("crypto:1", 200n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 214n, b, DON_FORWARDER as `0x${string}`),
      settled("crypto:1", 214n, b),
    ]);

    const byKey = new Map(attempts.map((x) => [x.marketKey, x]));
    expect(byKey.get(crypto0.key)!.report!.forwarder).toBe(MOCK_FORWARDER);
    expect(byKey.get("crypto:1")!.report!.forwarder).toBe(DON_FORWARDER);

    // And the sentence each one earns differs, which is the whole point of
    // carrying the address instead of reading it off config at render time.
    expect(attestationFor(byKey.get(crypto0.key)!.report!.forwarder)).toContain(
      "not DON consensus",
    );
    expect(attestationFor(byKey.get("crypto:1")!.report!.forwarder)).toContain(
      "signed by the DON",
    );
  });

  it("marks a refused delivery as rejected, not as still waiting", () => {
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", false, 112n),
    ]);

    expect(attempts[0]!.state).toBe("rejected");
    expect(attempts[0]!.settled).toBeNull();
    expect(inFlight(build([requested(crypto0.key, 100n), report(CRYPTO_MARKET_ADDRESS, "crypto", false, 112n)]))).toHaveLength(1);
  });

  /**
   * Absence of the forwarder log is absence of scan coverage, not proof that
   * something went wrong. Calling it rejected would accuse the chain of a
   * failure it never reported.
   */
  it("distinguishes a settlement with no report in range from a refusal", () => {
    const t = tx();
    const { attempts } = build([requested(crypto0.key, 100n), settled(crypto0.key, 114n, t)]);

    expect(attempts[0]!.state).toBe("settled-unattested");
  });

  /**
   * A refused report AFTER the market settled is a re-delivery of something
   * already decided — the cron sweeps produce these on purpose by re-settling
   * inside the finality window. It is not pinned on the settled market, both
   * because that market plainly did not fail and because the report names no
   * market at all.
   *
   * An earlier version attached it to the most recent candidate, which put
   * refusals onto markets that had settled and paid out days before — and then
   * hid them, because a paid attempt outranked a refusal when the state was
   * computed. Found by running the page against real history, not by reading.
   */
  it("does not pin a post-settlement refusal on the market that settled", () => {
    const t = tx();
    const { attempts, unattributed } = build([
      requested(crypto0.key, 100n),
      settled(crypto0.key, 114n, t),
      report(CRYPTO_MARKET_ADDRESS, "crypto", false, 200n),
    ]);

    expect(attempts[0]!.state).toBe("settled-unattested");
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]!.reason).toBe("duplicate");
    expect(unattributed[0]!.openAtBlock).toBe(0);
  });

  /** A refusal must never be buried under a later, happier-looking status. */
  it("keeps a refusal visible even when the market was later paid out", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", false, 110n),
      // A second attempt settles and pays; the first must still read refused.
      requested(crypto0.key, 200n),
      settled(crypto0.key, 214n, t),
      payout(crypto0.key, 230n, "claim"),
    ]);

    expect(attempts[0]!.state).toBe("rejected");
    expect(attempts[1]!.state).toBe("paid");
  });

  /** A void is a successfully delivered refund decision, not a failure. */
  it("treats a void outcome as settled", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
      settled(crypto0.key, 114n, t, Outcome.Void, 0n),
    ]);

    expect(attempts[0]!.state).toBe("settled");
  });

  it("counts payouts and reports the attempt as paid", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
      settled(crypto0.key, 114n, t),
      payout(crypto0.key, 130n, "claim"),
    ]);

    expect(attempts[0]!.state).toBe("paid");
    expect(attempts[0]!.payouts).toHaveLength(1);
  });

  /**
   * THE COLLISION. Identical topic0, identical marketId — only the emitting
   * contract differs. Merging these would pay one market's settlement against
   * another's holders.
   */
  it("keeps crypto and AMM apart despite identical events and ids", () => {
    const t1 = tx();
    const t2 = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      requested(amm0.key, 101n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t1),
      settled(crypto0.key, 114n, t1),
      report(AMM_MARKET_ADDRESS, "amm", true, 115n, t2),
      settled(amm0.key, 115n, t2),
    ]);

    expect(new Set(attempts.map((a) => a.marketKey)).size).toBe(2);
    expect(attempts.every((a) => a.state === "settled")).toBe(true);
  });

  it("does not blame a market when several were in flight on one contract", () => {
    const { attempts, unattributed } = build([
      requested(crypto0.key, 100n),
      requested("crypto:1", 101n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", false, 110n),
    ]);

    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]!.reason).toBe("ambiguous");
    expect(unattributed[0]!.openAtBlock).toBe(2);
    expect(attempts.every((a) => a.state === "in-flight")).toBe(true);
  });

  it("splits a market requested twice into two attempts", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", false, 110n),
      requested(crypto0.key, 200n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 214n, t),
      settled(crypto0.key, 214n, t),
    ]);

    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.state).toBe("rejected");
    expect(attempts[1]!.state).toBe("settled");
  });

  /** The live feed rescans an overlapping window, so this must be a no-op. */
  it("is idempotent over repeated logs", () => {
    const t = tx();
    const logs = [
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
      settled(crypto0.key, 114n, t),
    ];

    expect(build([...logs, ...logs])).toEqual(build(logs));
  });

  it("keeps a claim and a redemption on their own markets", () => {
    const t1 = tx();
    const t2 = tx();
    const { attempts } = build([
      requested(flight0.key, 100n),
      settled(flight0.key, 110n, t1),
      requested(amm0.key, 120n),
      settled(amm0.key, 130n, t2),
      payout(flight0.key, 140n, "claim"),
      payout(amm0.key, 141n, "redeem"),
    ]);

    const flight = attempts.find((a) => a.marketKey === flight0.key)!;
    const amm = attempts.find((a) => a.marketKey === amm0.key)!;
    expect(flight.payouts.map((p) => p.via)).toEqual(["claim"]);
    expect(amm.payouts.map((p) => p.via)).toEqual(["redeem"]);
  });

  /** An early arrival is a negative delay and must survive as one. */
  it("keeps a negative flight delay negative", () => {
    const t = tx();
    const { attempts } = build([
      requested(flight0.key, 100n),
      settled(flight0.key, 110n, t, Outcome.No, -12n),
    ]);

    expect(attempts[0]!.settled?.observedValue).toBe(-12n);
  });

  it("still shows an attempt whose market failed to load", () => {
    const { attempts } = buildPipelines([], [requested("stocks:7", 100n)]);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.market).toBeNull();
    expect(attempts[0]!.marketKey).toBe("stocks:7");
  });

  it("counts a liquidity withdrawal as a payout", () => {
    const t = tx();
    const lp: LpEvent[] = [
      {
        marketKey: amm0.key,
        provider: "0x00000000000000000000000000000000000a11ce",
        direction: "withdraw",
        amount: 5_000_000n,
        lpShares: 1_000_000n,
        totalLpShares: 0n,
        blockNumber: 150n,
        txHash: tx(),
      },
    ];
    const { attempts } = build([requested(amm0.key, 100n), settled(amm0.key, 110n, t)], lp);

    expect(attempts[0]!.state).toBe("paid");
  });
});

describe("timing", () => {
  /** Blocks are always knowable; seconds are not, and must not be invented. */
  it("reports blocks but leaves seconds null without timestamps", () => {
    const t = tx();
    const { attempts } = build([
      requested(crypto0.key, 100n),
      report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
      settled(crypto0.key, 114n, t),
    ]);

    expect(attempts[0]!.blocksToReport).toBe(14);
    expect(attempts[0]!.secondsToReport).toBeNull();
  });

  it("uses real timestamps when both ends are known", () => {
    const t = tx();
    const times = new Map<bigint, number>([
      [100n, 1_700_000_000],
      [114n, 1_700_000_168],
    ]);
    const { attempts } = build(
      [
        requested(crypto0.key, 100n),
        report(CRYPTO_MARKET_ADDRESS, "crypto", true, 114n, t),
        settled(crypto0.key, 114n, t),
      ],
      [],
      times,
    );

    expect(attempts[0]!.secondsToReport).toBe(168);
  });
});

describe("inFlight / history", () => {
  it("separates what is waiting from what is done", () => {
    const t = tx();
    const p = build([
      requested(crypto0.key, 100n),
      requested(amm0.key, 200n),
      report(AMM_MARKET_ADDRESS, "amm", true, 214n, t),
      settled(amm0.key, 214n, t),
    ]);

    expect(inFlight(p).map((a) => a.marketKey)).toEqual([crypto0.key]);
    expect(history(p).map((a) => a.marketKey)).toEqual([amm0.key]);
  });
});


/**
 * The one case where the logs cannot see the whole truth.
 *
 * `ownerVoid` is the POC escape hatch on every market contract: it writes
 * `Status.Void` and emits nothing at all. A pipeline built from logs alone
 * therefore keeps such a market at the top of the page reading "waiting for a
 * report" for ever — which is the single thing a live page must never do,
 * claim something is in progress when it is over.
 *
 * The fix reads `market.status`, and only ever to move an attempt OUT of
 * flight. These tests pin that narrowness: it must not invent a settlement,
 * and it must not touch a market that really is still waiting.
 */
describe("a market voided with no settlement log", () => {
  const voided: Market = { ...flight0, status: MarketStatus.Void };
  const waiting: Market = { ...flight0, status: MarketStatus.SettlementRequested };

  it("stops claiming the market is in flight", () => {
    const { attempts } = buildPipelines([voided], [requested(flight0.key, 100n)]);
    expect(attempts[0]!.state).toBe("abandoned");
  });

  it("leaves it out of the in-flight list and puts it in history", () => {
    const p = buildPipelines([voided], [requested(flight0.key, 100n)]);
    expect(inFlight(p)).toHaveLength(0);
    expect(history(p)).toHaveLength(1);
  });

  it("invents no settlement — there is none to show", () => {
    const { attempts } = buildPipelines([voided], [requested(flight0.key, 100n)]);
    expect(attempts[0]!.settled).toBeNull();
    expect(attempts[0]!.report).toBeNull();
  });

  it("still shows a market that is genuinely awaiting settlement", () => {
    const p = buildPipelines([waiting], [requested(flight0.key, 100n)]);
    expect(p.attempts[0]!.state).toBe("in-flight");
    expect(inFlight(p)).toHaveLength(1);
  });

  /**
   * A refusal outranks it. The market being Void afterwards does not erase
   * the fact that a delivery was attempted and rejected — that is the whole
   * reason this module reads forwarder logs at all.
   */
  it("does not bury a refused report", () => {
    const r = report(flight0.contract, "flights", false, 110n);
    const p = buildPipelines([voided], [requested(flight0.key, 100n), r]);
    expect(p.attempts[0]!.state).toBe("rejected");
  });
});
