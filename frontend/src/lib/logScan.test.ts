import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseEventLogs, toEventSelector } from "viem";
import { SETTLEMENT_EVENTS } from "./settlementEvents";
import { CRYPTO_MARKET_ADDRESS, FLIGHT_MARKET_ADDRESS } from "./config";
import type { RawLog } from "./logScan";

/**
 * The consolidated scan asks for EVERY log our five contracts emit, in one
 * query per chunk, and sorts them out afterwards by topic0. That trade — one
 * request instead of twenty — is only safe if topic0 really does separate
 * them, and there are two places it very nearly does not:
 *
 *   Settled(uint256,uint8,int256,bytes32)   crypto, stock, reserve, amm
 *   Settled(uint256,uint8,int32,bytes32)    flight, which predates the base
 *
 * Same NAME, same indexed argument, different width. A reader that matched on
 * the event name would decode a flight's int32 delay through an int256 ABI and
 * produce a number rather than an error. These tests assert the separation
 * holds and that `parseEventLogs` acts on topic0, not on the name.
 */

const log = (
  address: `0x${string}`,
  event: (typeof SETTLEMENT_EVENTS)[keyof typeof SETTLEMENT_EVENTS],
  args: Record<string, unknown>,
  logIndex: number,
): RawLog => {
  // Widened deliberately: this helper builds a log for ANY of the nine event
  // shapes, and the narrow per-event types cannot express that without a
  // switch that would duplicate the table it is testing.
  const inputs = event.inputs as readonly { name?: string; indexed?: boolean }[];
  const indexed = inputs.filter((i) => i.indexed);
  const body = inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({
      abi: [event],
      args: Object.fromEntries(
        indexed.map((i) => [i.name!, args[i.name!]]),
      ) as never,
    }),
    data: encodeAbiParameters(
      body as never,
      body.map((i) => args[i.name!]) as never,
    ),
    blockNumber: 100n,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  } as RawLog;
};

describe("topic0 separates the look-alikes", () => {
  it("gives the two Settled variants different selectors", () => {
    expect(toEventSelector(SETTLEMENT_EVENTS.flightSettled)).not.toBe(
      toEventSelector(SETTLEMENT_EVENTS.cryptoSettled),
    );
  });

  it("gives all four SettlementRequested variants different selectors", () => {
    const selectors = [
      SETTLEMENT_EVENTS.cryptoRequested,
      SETTLEMENT_EVENTS.flightRequested,
      SETTLEMENT_EVENTS.stockRequested,
      SETTLEMENT_EVENTS.reserveRequested,
    ].map(toEventSelector);
    expect(new Set(selectors).size).toBe(selectors.length);
  });

  /**
   * The whole consolidation rests on this: every event the five contracts emit
   * has to be distinguishable in one undifferentiated pile. A collision would
   * not error — it would decode one event through another's ABI.
   */
  it("keeps every settlement event distinct except crypto/AMM, which share by design", () => {
    const all = Object.values(SETTLEMENT_EVENTS).map(toEventSelector);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("parseEventLogs picks by topic0, not by name", () => {
  const flightSettled = log(
    FLIGHT_MARKET_ADDRESS,
    SETTLEMENT_EVENTS.flightSettled,
    { marketId: 3n, outcome: 2, observedDelay: -7, evidenceHash: `0x${"11".repeat(32)}` },
    0,
  );
  const cryptoSettled = log(
    CRYPTO_MARKET_ADDRESS,
    SETTLEMENT_EVENTS.cryptoSettled,
    {
      marketId: 13n,
      outcome: 1,
      observedValue: 7_655_308_000_000n,
      evidenceHash: `0x${"22".repeat(32)}`,
    },
    1,
  );
  const pile = [flightSettled, cryptoSettled];

  it("returns only the crypto variant for the crypto ABI", () => {
    const got = parseEventLogs({ abi: [SETTLEMENT_EVENTS.cryptoSettled], logs: pile });
    expect(got).toHaveLength(1);
    expect(got[0].args.marketId).toBe(13n);
    expect(got[0].args.observedValue).toBe(7_655_308_000_000n);
  });

  it("returns only the flight variant for the flight ABI, sign intact", () => {
    const got = parseEventLogs({ abi: [SETTLEMENT_EVENTS.flightSettled], logs: pile });
    expect(got).toHaveLength(1);
    expect(got[0].args.marketId).toBe(3n);
    // An early arrival is a negative delay and must survive as one.
    expect(got[0].args.observedDelay).toBe(-7);
  });

  it("ignores events it was not asked for", () => {
    const got = parseEventLogs({ abi: [SETTLEMENT_EVENTS.claimed], logs: pile });
    expect(got).toHaveLength(0);
  });
});
