import { decodeAbiParameters, parseAbiParameters } from "viem"
import { describe, expect, test } from "bun:test"
import {
  checkRoundUsable,
  initWorkflow,
  idsToScan,
  newReadBudget,
  outcomeFor,
  parseAeroDataBoxUtc,
  normalizeToEightDecimals,
  reconcileVenuePrices,
  resolveStockOutcome,
  toScaledPrice,
  onCryptoSettlementRequested,
  onReserveSettlementRequested,
  onSettlementRequested,
  onStockSettlementRequested,
  onSweepCrypto,
  onSweepFlights,
  onSweepStocks,
  walkToRoundInForce,
  type Config,
  type FeedRound,
  retryDelayMs,
  onFillOrders,
  encodeFillReport,
  onRequestDue,
  encodeKeeperReport,
  KEEPER_REQUESTS_PER_REPORT,
  onScheduleMarkets,
  nextSlot,
  roundStrike,
  scheduledQuestion,
  encodeSchedulerReport,
  SCHEDULE_MIN_STAKING_SECONDS,
  SCHEDULER_SPECS_PER_REPORT,
  schedulerGasLimit,
  flightSlot,
  candidateFor,
  specFor,
  scheduledSlotKey,
  onSportsCycle,
  onScheduleCycle,
  footballDigest,
  footballResult,
  footballToOpen,
  encodeSportsReport,
  sportsGasLimit,
  SPORTS_HOME,
  SPORTS_DRAW,
  SPORTS_AWAY,
  SPORTS_VOID,
  type FootballMatch,
} from "./main"

/**
 * The rules that decide who gets paid.
 *
 * Every one of these was previously verified only by running the workflow
 * against the live chain — slow, costs gas, and unable to reach the cases that
 * matter most (a stalled feed, venues straddling the strike, a market whose
 * price never moved). They are pure functions, so none of that is necessary.
 *
 * Constants are the real measurements from RUNBOOK.md rather than round
 * numbers, so a test failing points at a real scenario.
 */

const OUTCOME_YES = 1
const OUTCOME_NO = 2
const OUTCOME_VOID = 3

// $63,000.00 and $840.00 at the 8 decimals both the feeds and the contracts use.
const BTC_STRIKE = 6_300_000_000_000
const CSPX_STRIKE = 84_000_000_000n

const round = (answer: bigint, updatedAt: number): FeedRound => ({
  roundId: 1n,
  answer,
  updatedAt,
})

describe("outcomeFor — flight rules", () => {
  test("a confirmed cancellation pays Yes", () => {
    expect(outcomeFor({ status: "cancelled", delayMinutes: 0 }, 30)).toBe(OUTCOME_YES)
  })

  test("a landing at or past the threshold pays Yes", () => {
    expect(outcomeFor({ status: "landed", delayMinutes: 30 }, 30)).toBe(OUTCOME_YES)
    expect(outcomeFor({ status: "landed", delayMinutes: 42 }, 30)).toBe(OUTCOME_YES)
  })

  test("a landing one minute short pays No", () => {
    expect(outcomeFor({ status: "landed", delayMinutes: 29 }, 30)).toBe(OUTCOME_NO)
  })

  test("an early arrival pays No, not void", () => {
    expect(outcomeFor({ status: "landed", delayMinutes: -33 }, 45)).toBe(OUTCOME_NO)
  })

  /**
   * CanceledUncertain buckets to "airborne". It is a maybe, not a fact, and it
   * carried 13% of sampled ORD arrivals — settling it as a cancellation paid
   * real money on an unconfirmed signal.
   */
  test("anything short of a confirmed result voids", () => {
    for (const status of ["airborne", "unavailable"]) {
      expect(outcomeFor({ status, delayMinutes: 90 }, 30)).toBe(OUTCOME_VOID)
    }
  })
})

describe("parseAeroDataBoxUtc", () => {
  /**
   * AeroDataBox returns "2026-08-14 12:55Z", which is not RFC 3339 — a space
   * instead of the T. QuickJS's Date.parse returns NaN for it, so the workflow
   * parses the parts itself.
   */
  test("parses the provider's space-separated form, in milliseconds", () => {
    expect(parseAeroDataBoxUtc("2026-08-14 12:55Z")).toBe(Date.UTC(2026, 7, 14, 12, 55))
  })

  test("a delay is the difference in whole minutes", () => {
    const scheduled = parseAeroDataBoxUtc("2026-08-14 12:55Z")
    const actual = parseAeroDataBoxUtc("2026-08-14 13:37Z")
    expect(Math.round((actual - scheduled) / 60_000)).toBe(42)
  })

  test("handles an early arrival as a negative delay", () => {
    const scheduled = parseAeroDataBoxUtc("2026-08-13 18:00Z")
    const actual = parseAeroDataBoxUtc("2026-08-13 17:27Z")
    expect(Math.round((actual - scheduled) / 60_000)).toBe(-33)
  })

  /**
   * Deliberately strict: it accepts one provider's one format and throws on
   * anything else. This function exists because `Date.parse` silently guessed
   * differently in QuickJS than in V8, so guessing is the behaviour being
   * avoided — a throw voids the market, which is the safe direction.
   */
  test("throws on any other shape rather than guessing", () => {
    for (const bad of ["2026-08-14T12:55Z", "2026-08-14 12:55:30Z", "not a date", ""]) {
      expect(() => parseAeroDataBoxUtc(bad)).toThrow()
    }
  })
})

describe("reconcileVenuePrices — crypto", () => {
  const venues = ["coinbase", "bitstamp", "kraken"]

  test("takes the median when all venues agree on the side of the strike", () => {
    const prices = [6_302_301_000_000, 6_302_026_000_000, 6_302_552_000_000]
    expect(reconcileVenuePrices(venues, prices, BTC_STRIKE, "BTC")).toBe(6_302_301_000_000)
  })

  /**
   * The case the rule exists for: venues 40 cents apart, straddling the strike.
   * Numerically they agree to four decimal places; they disagree completely
   * about who gets paid. Measured live on ETH at a $1,882 strike.
   */
  test("voids when venues straddle the strike, however close they are", () => {
    const strike = 188_200_000_000
    const prices = [188_201_000_000, 188_173_000_000, 188_213_000_000]
    expect(() => reconcileVenuePrices(venues, prices, strike, "ETH")).toThrow(/disagree/)
  })

  test("settles on the strike itself as Yes, matching the contract's >=", () => {
    const prices = [BTC_STRIKE, BTC_STRIKE, BTC_STRIKE]
    expect(reconcileVenuePrices(venues, prices, BTC_STRIKE, "BTC")).toBe(BTC_STRIKE)
  })

  test("agrees on No when every venue is below", () => {
    const prices = [6_299_976_000_000, 6_298_343_000_000, 6_299_000_000_000]
    expect(reconcileVenuePrices(venues, prices, BTC_STRIKE, "BTC")).toBe(6_299_000_000_000)
  })

  test("refuses to invent an answer from no data", () => {
    expect(() => reconcileVenuePrices([], [], BTC_STRIKE, "BTC")).toThrow()
  })

  /**
   * A venue that cannot answer is not a venue that disagrees. Crypto market 14
   * voided on the DON for exactly this: Kraken serves about twelve hours of
   * one-minute candles and the market was settled 38 hours after expiry, so
   * the agreement between Coinbase and Bitstamp was thrown away with it.
   */
  test("settles on two venues when the third cannot answer", () => {
    const prices = [6_302_301_000_000, 6_302_026_000_000];
    expect(reconcileVenuePrices(["coinbase", "bitstamp"], prices, BTC_STRIKE, "BTC")).toBe(
      6_302_301_000_000,
    )
  })

  /** One venue is a single observer, which is the thing this rule exists to refuse. */
  test("refuses a single venue, however confident it sounds", () => {
    expect(() =>
      reconcileVenuePrices(["coinbase"], [6_302_301_000_000], BTC_STRIKE, "BTC"),
    ).toThrow(/need 2/)
  })

  /** Tolerating absence must not tolerate disagreement — the property survives. */
  test("still voids when the two that answered straddle the strike", () => {
    const strike = 188_200_000_000
    expect(() =>
      reconcileVenuePrices(["coinbase", "kraken"], [188_201_000_000, 188_173_000_000], strike, "ETH"),
    ).toThrow(/disagree/)
  })

  /** The error should name who was missing, not merely how many. */
  test("names the venues that did answer", () => {
    expect(() => reconcileVenuePrices(["bitstamp"], [1], BTC_STRIKE, "BTC")).toThrow(/bitstamp/)
  })
})

describe("checkRoundUsable — feed staleness", () => {
  const expiry = 1_786_996_800

  test("accepts a round published within tolerance", () => {
    expect(() => checkRoundUsable(round(83_869_000_000n, expiry - 3_600), expiry, 100_000)).not.toThrow()
  })

  /**
   * EUTBL NAV on Sepolia was last published in April and still answers. A feed
   * that stopped is exactly what this catches.
   */
  test("rejects a round older than the market's tolerance", () => {
    const fourMonths = 120 * 24 * 3_600
    expect(() => checkRoundUsable(round(1_030_900n, expiry - fourMonths), expiry, 100_000)).toThrow(
      /old/,
    )
  })

  test("rejects a non-positive answer", () => {
    expect(() => checkRoundUsable(round(0n, expiry), expiry, 100_000)).toThrow()
    expect(() => checkRoundUsable(round(-1n, expiry), expiry, 100_000)).toThrow()
  })

  test("accepts a round published after expiry, which is not staleness", () => {
    expect(() => checkRoundUsable(round(83_869_000_000n, expiry + 60), expiry, 100_000)).not.toThrow()
  })
})

describe("normalizeToEightDecimals", () => {
  /**
   * Real Sepolia feeds, real raw answers. Assuming 8 decimals for all of them
   * is wrong in both directions and by five orders of magnitude at worst.
   */
  test("leaves an 8-decimal feed untouched (CSPX $838.69)", () => {
    expect(normalizeToEightDecimals(83_869_000_000n, 8)).toBe(83_869_000_000n)
  })

  test("scales a 6-decimal feed up (USTB NAV $11.177748)", () => {
    // Read as 8 decimals this was $0.11 instead of $11.18.
    expect(normalizeToEightDecimals(11_177_748n, 6)).toBe(1_117_774_800n)
  })

  test("scales an 18-decimal feed down (stETH reserves, 9.5M)", () => {
    const raw = 9_505_650_857_465_828_722_927_470n
    const normalized = normalizeToEightDecimals(raw, 18)
    // 9,505,650.85746582 tokens — matching what the feed actually reports.
    expect(normalized).toBe(950_565_085_746_582n)
    // The raw answer is far past a uint64 strike; the normalized one is not.
    expect(raw > 18_446_744_073_709_551_615n).toBe(true)
    expect(normalized < 18_446_744_073_709_551_615n).toBe(true)
  })

  test("scaling up then down is lossless for feeds coarser than 8", () => {
    expect(normalizeToEightDecimals(37_621_700_820_000n, 6) / 100n).toBe(37_621_700_820_000n)
  })
})

describe("resolveStockOutcome — the trading-calendar check", () => {
  const close = round(83_869_000_000n, 1_786_953_600)

  test("pays Yes when the price at expiry is at or above the strike", () => {
    expect(resolveStockOutcome(round(84_100_000_000n, 0), close, CSPX_STRIKE, 8).outcome).toBe(
      OUTCOME_YES,
    )
    expect(resolveStockOutcome(round(CSPX_STRIKE, 0), close, CSPX_STRIKE, 8).outcome).toBe(
      OUTCOME_YES,
    )
  })

  test("pays No when it is below", () => {
    expect(resolveStockOutcome(round(83_900_000_000n, 0), close, CSPX_STRIKE, 8).outcome).toBe(
      OUTCOME_NO,
    )
  })

  test("reports the observed price rescaled to 8 decimals", () => {
    // A 6-decimal feed at 840.500000 against an 8-decimal strike.
    const r = resolveStockOutcome(round(840_500_000n, 0), round(838_690_000n, 0), CSPX_STRIKE, 6)
    expect(r.observed).toBe(84_050_000_000n)
    expect(r.outcome).toBe(OUTCOME_YES)
  })

  /**
   * The weekend case, from real measurement: CSPX answered 838.69 on Friday
   * and the identical 838.69 on Saturday. A market spanning that was decided
   * before the book shut, so it must void rather than pay whoever noticed.
   */
  test("voids when the price never moved between close and expiry", () => {
    const frozen = round(83_869_000_000n, 1_786_996_800)
    expect(() => resolveStockOutcome(frozen, close, CSPX_STRIKE, 8)).toThrow(/did not move/)
  })

  test("voids on a frozen price even when it sits above the strike", () => {
    const above = round(84_100_000_000n, 1_786_996_800)
    const closeAtSameLevel = round(84_100_000_000n, 1_786_953_600)
    expect(() => resolveStockOutcome(above, closeAtSameLevel, CSPX_STRIKE, 8)).toThrow(
      /did not move/,
    )
  })

  test("a one-unit move is enough to count as movement", () => {
    const moved = round(83_869_000_001n, 1_786_996_800)
    expect(resolveStockOutcome(moved, close, CSPX_STRIKE, 8).outcome).toBe(OUTCOME_NO)
  })

  /**
   * Movement is checked on raw answers precisely so this case works: an
   * 18-decimal feed moving in a digit that rescaling to 8 would truncate away
   * must still count as having moved.
   */
  test("sees a move too small to survive rescaling", () => {
    const a = round(9_505_650_857_465_828_722_927_470n, 1_786_953_600)
    const b = round(9_505_650_857_465_828_722_927_471n, 1_786_996_800)
    expect(normalizeToEightDecimals(a.answer, 18)).toBe(normalizeToEightDecimals(b.answer, 18))
    expect(() => resolveStockOutcome(b, a, 1n, 18)).not.toThrow()
  })
})

describe("read budget", () => {
  /**
   * ChainRead.CallLimit is 15 per execution. Exceeding it aborts the whole run
   * after any writes already made have landed, so the budget is tracked rather
   * than trusted to loop bounds.
   */
  test("starts at the platform limit", () => {
    expect(newReadBudget().left).toBe(15)
  })

  test("subtracts what the caller reserves", () => {
    expect(newReadBudget(4).left).toBe(11)
  })

  test("scan window shrinks to whatever is left", () => {
    expect(idsToScan(100, 5)).toHaveLength(5)
    expect(idsToScan(3, 10)).toHaveLength(3)
    expect(idsToScan(0, 10)).toHaveLength(0)
  })

  /**
   * Newest first: markets are created and settle roughly in order, so anything
   * unresolved is at the end of the list.
   */
  test("scans the newest ids first", () => {
    expect(idsToScan(10, 3)).toEqual([9n, 8n, 7n])
  })
})

describe("toScaledPrice", () => {
  test("scales whole-unit prices to the contracts' 8 decimals", () => {
    expect(toScaledPrice(63_000)).toBe(6_300_000_000_000)
    expect(toScaledPrice(1_882.4)).toBe(188_240_000_000)
  })

  test("rounds rather than truncating, so a half cent does not vanish", () => {
    expect(toScaledPrice(63_000.000000005)).toBe(6_300_000_000_001)
  })
})


/**
 * Which round was in force at a moment.
 *
 * This is the piece that actually chose CSPX's settlement price, and until now
 * the only settlement rule with no test — it used to be welded to the
 * `eth_call` that fed it, so asking it a question meant standing up a chain.
 * The reader is now an argument, and these are the questions worth asking.
 */
describe("walkToRoundInForce", () => {
  /** A feed's history, newest first, as `(id, updatedAt)` pairs. */
  const history = (...stamps: number[]) => {
    const byId = new Map<bigint, FeedRound>()
    stamps.forEach((updatedAt, i) => {
      const id = BigInt(stamps.length - i)
      byId.set(id, { roundId: id, answer: BigInt(1_000 + i), updatedAt })
    })
    let reads = 0
    return {
      newest: byId.get(BigInt(stamps.length))!,
      reads: () => reads,
      read: (id: bigint) => {
        reads++
        const r = byId.get(id)
        if (!r) throw new Error(`Feed round ${id} is unset`)
        return r
      },
    }
  }

  test("returns the round it starts on when that one is already in force", () => {
    const h = history(1_000, 900)
    expect(walkToRoundInForce(h.read, h.newest, 1_500).updatedAt).toBe(1_000)
    expect(h.reads()).toBe(0)
  })

  /**
   * The boundary that decides a market settling exactly at the closing bell:
   * a round published ON the target was in force at it.
   */
  test("counts a round published exactly on the target as in force", () => {
    const h = history(1_000, 900)
    expect(walkToRoundInForce(h.read, h.newest, 1_000).updatedAt).toBe(1_000)
    expect(h.reads()).toBe(0)
  })

  test("walks back past every round published after the target", () => {
    const h = history(5_000, 4_000, 3_000, 2_000, 1_000)
    expect(walkToRoundInForce(h.read, h.newest, 2_500).updatedAt).toBe(2_000)
    expect(h.reads()).toBe(3)
  })

  /**
   * CSPX, as it actually happened. One round on Monday and nothing after it,
   * so expiry resolves to Monday's print and the close — twelve hours earlier
   * — resolves back to Sunday's. Those two being DIFFERENT is what let the
   * market settle instead of voiding.
   */
  test("reproduces the CSPX settlement, both lookups", () => {
    const sunday = 1_786_874_616
    const monday = 1_786_961_040
    const close = 1_786_953_600
    const expiry = 1_786_996_800

    const h = history(monday, sunday)
    const atExpiry = walkToRoundInForce(h.read, h.newest, expiry)
    expect(atExpiry.updatedAt).toBe(monday)

    // The second lookup continues from where the first stopped, which is the
    // whole reason `from` is a parameter rather than always the latest round.
    const atClose = walkToRoundInForce(h.read, atExpiry, close)
    expect(atClose.updatedAt).toBe(sunday)
    expect(atClose.answer).not.toBe(atExpiry.answer)
  })

  test("gives up rather than walking forever", () => {
    const h = history(9_000, 8_000, 7_000, 6_000, 5_000)
    expect(() => walkToRoundInForce(h.read, h.newest, 1_000, 3)).toThrow(/within 3 rounds/)
  })

  /**
   * Walking off the start of a feed's history throws from the reader, not from
   * here. Worth pinning: the message a caller sees decides whether a market
   * voids with a useful reason or an opaque one.
   */
  test("surfaces the reader's own error when the history runs out", () => {
    const h = history(5_000, 4_000)
    expect(() => walkToRoundInForce(h.read, h.newest, 1_000)).toThrow(/is unset/)
  })
})


/**
 * Which handler each `--trigger-index` selects.
 *
 * These numbers are positions in a list `initWorkflow` builds at runtime, not
 * fixed ids, and a handler only joins the list when its contract address is
 * non-empty. Adding the reserve handler at position 3 once renumbered all three
 * cron sweeps and left RUNBOOK.md telling the reader to settle flights with
 * index 3 — which by then was the reserve log handler. Nothing failed loudly;
 * the wrong sweep simply ran.
 *
 * So the ordering is asserted against the real `initWorkflow` rather than
 * restated here. Insert a handler and these break, which is the point: the
 * table in RUNBOOK.md has to move in the same commit.
 */
describe("trigger indices", () => {
  const fullConfig = {
    flightContractAddress: "0x0900000000000000000000000000000000000001",
    chainSelectorName: "ethereum-testnet-sepolia",
    apiUrl: "https://example.invalid",
    apiKey: "unused",
    gasLimit: "1000000",
    cryptoContractAddress: "0x0900000000000000000000000000000000000002",
    stockContractAddress: "0x0900000000000000000000000000000000000003",
    reserveContractAddress: "0x0900000000000000000000000000000000000004",
    ammContractAddress: "0x0900000000000000000000000000000000000005",
    sweepSchedule: "0 0,30 * * * *",
  } as Config

  const handlersFor = (overrides: Partial<Config> = {}) =>
    initWorkflow({ ...fullConfig, ...overrides }).map((h) => h.fn)

  test("match the table in RUNBOOK.md when every address is configured", () => {
    expect(handlersFor()).toEqual([
      onSettlementRequested, // 0 — flight log
      onCryptoSettlementRequested, // 1 — crypto log, also serves the AMM
      onStockSettlementRequested, // 2 — stock log
      onReserveSettlementRequested, // 3 — reserve log
      onSweepFlights, // 4
      onSweepCrypto, // 5
      onSweepStocks, // 6
    ])
  })

  /**
   * The renumbering itself, pinned. Emptying one address does not disable one
   * index — it slides every later handler down by one, which is exactly how the
   * documented indices went wrong the first time.
   */
  test("shift down when a contract address is left empty", () => {
    const withoutReserve = handlersFor({ reserveContractAddress: "" })

    expect(withoutReserve).toHaveLength(6)
    expect(withoutReserve[3]).toBe(onSweepFlights)
    expect(withoutReserve.indexOf(onReserveSettlementRequested)).toBe(-1)
  })

  test("drop the sweeps entirely when no schedule is set", () => {
    expect(handlersFor({ sweepSchedule: "" })).toEqual([
      onSettlementRequested,
      onCryptoSettlementRequested,
      onStockSettlementRequested,
      onReserveSettlementRequested,
    ])
  })

  /**
   * A sweep over a contract that is not configured is not a quiet no-op: it
   * calls the zero address, gets `0x` back, and throws while decoding — once
   * every schedule tick, for ever. So each sweep is guarded by its own
   * address, and the zero address counts as absent.
   *
   * This is the production shape as of 2026-09-20: flights are silenced while
   * their provider cannot serve ten nodes at once, and the sweeps for the two
   * families that need no API key run without them.
   */
  test("skip a sweep whose contract is silenced by the zero address", () => {
    const handlers = handlersFor({
      flightContractAddress: "0x0000000000000000000000000000000000000000",
    })

    // The flight LOG handler still registers — it is waiting for an event
    // nobody emits, which costs nothing. The flight SWEEP does not.
    expect(handlers[0]).toBe(onSettlementRequested)
    expect(handlers).not.toContain(onSweepFlights)
    expect(handlers).toContain(onSweepCrypto)
    expect(handlers).toContain(onSweepStocks)
  })

  test("skip a sweep whose contract address is empty", () => {
    expect(handlersFor({ stockContractAddress: "" })).not.toContain(onSweepStocks)
  })
})


/**
 * Ten nodes against a rate limit that tolerates one.
 *
 * Measured 2026-09-20: one node got an answer and nine got HTTP 429, in the
 * same second, and the settlement voided. The fix is not to call less — a DON
 * calls once per node by definition — but to stop calling at the same instant.
 *
 * These tests are about the SPREAD, not about any single delay. A backoff that
 * returns the same number for every node would pass a naive "is it positive?"
 * check and move the collision instead of dissolving it.
 */
describe("retryDelayMs", () => {
  const window = 1_500

  test("lands inside the window for the first attempt", () => {
    for (const seed of [0, 1, 7, 12345, 999_999_999]) {
      const d = retryDelayMs(0, seed, window)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(window)
    }
  })

  test("doubles the WINDOW on each attempt, not the value", () => {
    // The ceiling is what doubles. The value only tracks it approximately,
    // because flooring a doubled product is not the same as doubling a
    // floored one — a distinction worth a test rather than a surprise.
    const seed = 987_654
    for (const attempt of [0, 1, 2]) {
      const ceiling = window * 2 ** attempt
      const delay = retryDelayMs(attempt, seed, window)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(ceiling)
    }

    const first = retryDelayMs(0, seed, window)
    // Within one unit of exactly doubling, which is the floor's whole error.
    expect(Math.abs(retryDelayMs(1, seed, window) - first * 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(retryDelayMs(2, seed, window) - first * 4)).toBeLessThanOrEqual(3)
  })

  /**
   * The property that actually matters. Ten different seeds must not collapse
   * onto a handful of delays, or the nodes arrive together anyway.
   */
  test("spreads ten different seeds across the window", () => {
    const seeds = [11, 250_003, 417_889, 600_001, 733_331, 812_345, 904_321, 55_555, 123_457, 987_653]
    const delays = seeds.map((s) => retryDelayMs(0, s, window))

    expect(new Set(delays).size).toBe(seeds.length)
    // And they are actually spread, not clustered in one corner of it.
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(window / 2)
  })

  /**
   * The SDK documents `randomSeed` only as "random seed value" and says
   * nothing about its range, so both readings have to work: a float already in
   * [0,1), and a large integer.
   */
  test("folds a seed of any magnitude into the window", () => {
    expect(retryDelayMs(0, 0.25, window)).toBe(375)
    expect(retryDelayMs(0, 2_000_006, window)).toBe(retryDelayMs(0, 0, window))
    expect(retryDelayMs(0, -0.75, window)).toBe(1125)
  })

  test("never returns a negative delay, whatever the host hands back", () => {
    for (const seed of [-1, -999_999, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(retryDelayMs(1, seed, window)).toBeGreaterThanOrEqual(0)
    }
  })
})


/**
 * The exchange's order filler.
 *
 * It is registered after every other handler on purpose: trigger indices are
 * positions in a list, and RUNBOOK's table has already been wrong once because
 * a handler was inserted in the middle.
 */
describe("exchange order filler", () => {
  const base = {
    flightContractAddress: "0x0900000000000000000000000000000000000001",
    chainSelectorName: "ethereum-testnet-sepolia",
    apiUrl: "https://example.invalid",
    apiKey: "unused",
    gasLimit: "1000000",
    cryptoContractAddress: "0x0900000000000000000000000000000000000002",
    stockContractAddress: "0x0900000000000000000000000000000000000003",
    reserveContractAddress: "0x0900000000000000000000000000000000000004",
    sweepSchedule: "0 0,30 * * * *",
  }
  const fns = (extra: Record<string, string>) =>
    initWorkflow({ ...base, ...extra } as Config).map((h) => h.fn)

  test("is appended after every existing handler", () => {
    const withExchange = fns({
      exchangeContractAddress: "0x0900000000000000000000000000000000000006",
      exchangeSchedule: "0 5,15,25,35,45,55 * * * *",
    })
    const without = fns({})
    expect(withExchange.slice(0, without.length)).toEqual(without)
    expect(withExchange.at(-1)).toBe(onFillOrders)
    expect(withExchange).toHaveLength(without.length + 1)
  })

  test("is not registered without a schedule, or with the zero address", () => {
    expect(fns({ exchangeContractAddress: "0x0900000000000000000000000000000000000006" })).not.toContain(onFillOrders)
    expect(
      fns({
        exchangeContractAddress: "0x0000000000000000000000000000000000000000",
        exchangeSchedule: "0 5,15,25,35,45,55 * * * *",
      }),
    ).not.toContain(onFillOrders)
  })

  /**
   * The contract decodes the report as `abi.decode(report, (uint256[]))`. The
   * report carries ids and nothing else — no price, no round — which is what
   * makes the DON a keeper rather than a party that could steer a fill.
   */
  test("encodes exactly the order ids, as the contract decodes them", () => {
    const encoded = encodeFillReport([3n, 7n])
    const [ids] = decodeAbiParameters(parseAbiParameters("uint256[]"), encoded)
    expect(ids).toEqual([3n, 7n])
  })
})

/**
 * The automatic settlement requester. It decides nothing — what is due, and
 * the six-hour wait for flights, live in SettlementKeeper — so what is worth
 * pinning here is where it sits in the trigger list and the exact shape of
 * the report the contract decodes.
 */
describe("automatic settlement requester", () => {
  const base = {
    flightContractAddress: "0x0900000000000000000000000000000000000001",
    chainSelectorName: "ethereum-testnet-sepolia",
    apiUrl: "https://example.invalid",
    apiKey: "unused",
    gasLimit: "1000000",
    cryptoContractAddress: "0x0900000000000000000000000000000000000002",
    stockContractAddress: "0x0900000000000000000000000000000000000003",
    reserveContractAddress: "0x0900000000000000000000000000000000000004",
    sweepSchedule: "0 0,30 * * * *",
    exchangeContractAddress: "0x0900000000000000000000000000000000000006",
    exchangeSchedule: "0 5,15,25,35,45,55 * * * *",
  }
  const fns = (extra: Record<string, string>) =>
    initWorkflow({ ...base, ...extra } as Config).map((h) => h.fn)

  test("is appended after the exchange filler, moving no existing index", () => {
    const withKeeper = fns({
      keeperContractAddress: "0x0900000000000000000000000000000000000007",
      keeperSchedule: "0 2,12,22,32,42,52 * * * *",
    })
    const without = fns({})
    expect(withKeeper.slice(0, without.length)).toEqual(without)
    expect(without.at(-1)).toBe(onFillOrders)
    expect(withKeeper.at(-1)).toBe(onRequestDue)
    expect(withKeeper).toHaveLength(without.length + 1)
  })

  test("is not registered without a schedule, or with the zero address", () => {
    expect(fns({ keeperContractAddress: "0x0900000000000000000000000000000000000007" })).not.toContain(onRequestDue)
    expect(
      fns({
        keeperContractAddress: "0x0000000000000000000000000000000000000000",
        keeperSchedule: "0 2,12,22,32,42,52 * * * *",
      }),
    ).not.toContain(onRequestDue)
  })

  /** `abi.decode(report, (address[], uint256[]))`, pairs in order. */
  test("encodes market contracts and ids as parallel arrays", () => {
    const crypto = "0x8DA11eb17D5F3f4427aA3017E95e50b132A210be"
    const flights = "0x09068EFB21FaBeAc59694E01428cF438Cf38e2b3"
    const encoded = encodeKeeperReport([crypto, flights], [0n, 17n])
    const [markets, ids] = decodeAbiParameters(parseAbiParameters("address[], uint256[]"), encoded)
    expect(markets).toEqual([crypto, flights])
    expect(ids).toEqual([0n, 17n])
  })

  test("asks for no more than one report can carry", () => {
    expect(KEEPER_REQUESTS_PER_REPORT).toBeGreaterThan(0)
    expect(KEEPER_REQUESTS_PER_REPORT).toBeLessThanOrEqual(5)
  })
})

/**
 * The market opener. Every node must name the same market from the same DON
 * time, so the slot arithmetic, the strike rounding and the question text are
 * pinned here; whether a slot is already open is the contract's to decide.
 */
describe("scheduled markets", () => {
  // Mon 2026-10-19 21:01:00 UTC — a run one minute into the hour.
  const T = Date.UTC(2026, 9, 19, 21, 1, 0) / 1000
  const hourly = { asset: "BTC" as const, horizonSeconds: 3600, closeBeforeSeconds: 900 }
  const daily = { asset: "ETH" as const, horizonSeconds: 86400, closeBeforeSeconds: 4 * 3600 }

  test("an hourly rule names the hour that ends next, closing 15 minutes before", () => {
    expect(nextSlot(hourly, T)).toEqual({
      expiryTime: Date.UTC(2026, 9, 19, 22, 0, 0) / 1000,
      closeTime: Date.UTC(2026, 9, 19, 21, 45, 0) / 1000,
    })
  })

  test("a daily rule names the next UTC midnight while its staking is open", () => {
    const morning = Date.UTC(2026, 9, 19, 0, 1, 0) / 1000
    expect(nextSlot(daily, morning)).toEqual({
      expiryTime: Date.UTC(2026, 9, 20) / 1000,
      closeTime: Date.UTC(2026, 9, 19, 20, 0, 0) / 1000,
    })
  })

  test("once a slot's staking has closed, the next one opens rather than none", () => {
    // 21:01, after today's 20:00 close: tomorrow's daily market, not a gap until midnight.
    expect(nextSlot(daily, T)).toEqual({
      expiryTime: Date.UTC(2026, 9, 21) / 1000,
      closeTime: Date.UTC(2026, 9, 20, 20, 0, 0) / 1000,
    })
    // An hourly run that fires late, five minutes before the 21:45 close.
    const late = Date.UTC(2026, 9, 19, 21, 40, 0) / 1000
    expect(nextSlot(hourly, late)?.expiryTime).toBe(Date.UTC(2026, 9, 19, 23, 0, 0) / 1000)
    const justInTime = Date.UTC(2026, 9, 19, 21, 45, 0) / 1000 - SCHEDULE_MIN_STAKING_SECONDS
    expect(nextSlot(hourly, justInTime)?.expiryTime).toBe(Date.UTC(2026, 9, 19, 22, 0, 0) / 1000)
  })

  test("a rule whose staking always closes before it could open opens nothing", () => {
    // Closing five days before expiry, against a contract that refuses expiries
    // more than four days out: no slot can ever have time left to stake.
    expect(nextSlot({ asset: "BTC", horizonSeconds: 3600, closeBeforeSeconds: 5 * 86400 }, T)).toBeNull()
  })

  test("strikes round to the nearest step a person would type", () => {
    expect(roundStrike(8_194_741_000_000n, 100)).toBe(8_190_000_000_000n) // $81,947.41 -> $81,900
    expect(roundStrike(8_195_000_000_000n, 100)).toBe(8_200_000_000_000n) // halves round up
    expect(roundStrike(239_556_705_611n, 10)).toBe(240_000_000_000n) // $2,395.57 -> $2,400
  })

  test("the question is the one the app's Create market form writes, in UTC", () => {
    expect(scheduledQuestion("BTC", 8_190_000_000_000n, Date.UTC(2026, 9, 19, 22, 0, 0) / 1000)).toBe(
      "Will BTC be at or above $81,900 at 22:00 UTC on Oct 19?",
    )
    expect(scheduledQuestion("ETH", 240_000_000_000n, Date.UTC(2026, 9, 20) / 1000)).toBe(
      "Will ETH be at or above $2,400 at 00:00 UTC on Oct 20?",
    )
  })

  test("asks for gas Sepolia actually charges: ~590k per newMarket, more for an AMM", () => {
    expect(SCHEDULER_SPECS_PER_REPORT).toBeLessThanOrEqual(2)
    expect(Number(schedulerGasLimit(["crypto"]))).toBeGreaterThanOrEqual(590_000 * 1.5 + 400_000)
    expect(Number(schedulerGasLimit(["amm"]))).toBeGreaterThan(Number(schedulerGasLimit(["crypto"])))
    expect(Number(schedulerGasLimit(["amm", "crypto"]))).toBe(400_000 + 2_200_000 + 1_100_000)
  })

  // Tue 2026-10-20 17:31 UTC.
  const TUE = Date.UTC(2026, 9, 20, 17, 31, 0) / 1000
  const FRI_EVE = Date.UTC(2026, 9, 23, 21, 0, 0) / 1000

  test("an offset puts a daily slot at a time of day, here 20:00 UTC", () => {
    const cspx = { kind: "stock" as const, symbol: "CSPX", horizonSeconds: 86400, offsetSeconds: 72000, closeBeforeSeconds: 43200 }
    // 17:31 is after today's 08:00 close, so tomorrow's 20:00.
    expect(nextSlot(cspx, TUE)).toEqual({
      expiryTime: Date.UTC(2026, 9, 21, 20, 0, 0) / 1000,
      closeTime: Date.UTC(2026, 9, 21, 8, 0, 0) / 1000,
    })
  })

  test("a weekdays-only rule skips a weekend expiry", () => {
    const xau = { kind: "stock" as const, symbol: "XAU", horizonSeconds: 14400, closeBeforeSeconds: 3600, weekdaysOnly: true }
    // Friday 21:00: Sat and Sun slots are skipped; Monday 00:00 is the first.
    expect(nextSlot(xau, FRI_EVE)?.expiryTime).toBe(Date.UTC(2026, 9, 26, 0, 0, 0) / 1000)
  })

  test("a flight is tomorrow's, closing when that day starts, settleable two days later", () => {
    expect(flightSlot({ kind: "flight", flight: "BA286", daysAhead: 1 }, TUE)).toEqual({
      closeTime: Date.UTC(2026, 9, 21) / 1000,
      expiryTime: Date.UTC(2026, 9, 23) / 1000,
      departureDate: 20261021,
    })
  })

  test("each kind's question reads like the app's", () => {
    const at = (rule: Parameters<typeof candidateFor>[0], price: bigint) => specFor(candidateFor(rule, TUE)!, price).question
    expect(at({ kind: "stock", symbol: "XAU", label: "gold (XAU)", horizonSeconds: 14400, closeBeforeSeconds: 3600, strikeStep: 10 }, 412_164_000_000n))
      .toBe("Will gold (XAU) be at or above $4,120 at 20:00 UTC on Oct 20?")
    expect(at({ kind: "reserve", symbol: "USTB", label: "USTB NAV per share", horizonSeconds: 86400, closeBeforeSeconds: 14400, strikeStep: 0.01 }, 1_125_104_100n))
      .toBe("Will USTB NAV per share be at or above $11.25 at 00:00 UTC on Oct 21?")
    expect(at({ kind: "reserve", symbol: "USDW", label: "USDW reserves", unit: "", horizonSeconds: 86400, closeBeforeSeconds: 14400, strikeStep: 100000 }, 4_928_569_806_000_000n))
      .toBe("Will USDW reserves be at or above 49,300,000 at 00:00 UTC on Oct 21?")
    expect(at({ kind: "flight", flight: "BA286", thresholdMinutes: 45, daysAhead: 1 }, 0n)).toBe(
      "Will BA286 on Oct 21 arrive 45m+ late?",
    )
    expect(at({ kind: "amm", asset: "BTC", horizonSeconds: 86400, closeBeforeSeconds: 14400 }, 8_194_741_000_000n)).toBe(
      "Will BTC be at or above $81,900 at 00:00 UTC on Oct 21?",
    )
  })

  test("a NAV strike sits at the expected accrual, to a tenth of a cent", () => {
    // USTB on Mon 2026-10-26 22:00 UTC: the weekly slot is Friday 20:00, staking to Thursday 20:00.
    const MON = Date.UTC(2026, 9, 26, 22, 0, 0) / 1000
    const ustb = {
      kind: "reserve" as const,
      symbol: "USTB",
      label: "USTB NAV per share",
      horizonSeconds: 604800,
      offsetSeconds: 158400,
      closeBeforeSeconds: 86400,
      strikeStep: 0.001,
      strikeOffset: 0.0045,
    }
    const c = candidateFor(ustb, MON)!
    expect(c.expiryTime).toBe(Date.UTC(2026, 9, 30, 20, 0, 0) / 1000)
    expect(c.closeTime).toBe(Date.UTC(2026, 9, 29, 20, 0, 0) / 1000)
    // 11.251041 + 0.0045 = 11.255541 -> 11.256
    expect(specFor(c, 1_125_104_100n).question).toBe(
      "Will USTB NAV per share be at or above $11.256 at 20:00 UTC on Oct 30?",
    )
  })

  test("terms are encoded the way MarketScheduler.openOne decodes each kind", () => {
    const flight = specFor(candidateFor({ kind: "flight", flight: "AA100", thresholdMinutes: 30 }, TUE)!, 0n)
    expect(flight.kind).toBe(3)
    expect(decodeAbiParameters(parseAbiParameters("uint32, uint16"), flight.terms)).toEqual([20261021, 30])

    const amm = specFor(candidateFor({ kind: "amm", asset: "BTC", horizonSeconds: 86400, closeBeforeSeconds: 14400, liquidity: 20 }, TUE)!, 8_194_741_000_000n)
    expect(amm.kind).toBe(4)
    expect(decodeAbiParameters(parseAbiParameters("uint8, uint64, uint256, uint256, uint16"), amm.terms)).toEqual([
      0, 8_190_000_000_000n, 20_000_000n, 5_000n, 30,
    ])

    const stock = specFor(candidateFor({ kind: "stock", symbol: "XAU", horizonSeconds: 14400, closeBeforeSeconds: 3600, strikeStep: 10, maxStalenessSeconds: 10800 }, TUE)!, 412_164_000_000n)
    expect(stock.id).toBe("XAU")
    expect(decodeAbiParameters(parseAbiParameters("uint64, uint32"), stock.terms)).toEqual([412_000_000_000n, 10800])
  })

  test("a slot key is the contract's keccak256(abi.encode(kind, close, expiry, id))", () => {
    // Computed with `cast keccak $(cast abi-encode "f(uint8,uint64,uint64,string)" 0 1792446300 1792447200 BTC)`.
    expect(scheduledSlotKey(0, 1792446300, 1792447200, "BTC")).toBe(
      "0x1f18baa90e950d538113ed4507fcb8ab31e88726020ee4af0a1dfa2433119d1e",
    )
  })

  test("encodes the specs exactly as MarketScheduler decodes them", () => {
    const spec = {
      kind: 0,
      closeTime: 1_792_446_300n,
      expiryTime: 1_792_447_200n,
      id: "BTC",
      question: "Will BTC be at or above $81,900 at 22:00 UTC on Oct 19?",
      terms: "0x1234" as `0x${string}`,
    }
    const [decoded] = decodeAbiParameters(
      parseAbiParameters("(uint8 kind, uint64 closeTime, uint64 expiryTime, string id, string question, bytes terms)[]"),
      encodeSchedulerReport([spec]),
    )
    expect(decoded).toEqual([spec])
  })

  const base = {
    flightContractAddress: "0x0900000000000000000000000000000000000001",
    chainSelectorName: "ethereum-testnet-sepolia",
    apiUrl: "https://example.invalid",
    apiKey: "unused",
    gasLimit: "1000000",
    cryptoContractAddress: "0x0900000000000000000000000000000000000002",
    stockContractAddress: "0x0900000000000000000000000000000000000003",
    reserveContractAddress: "0x0900000000000000000000000000000000000004",
    sweepSchedule: "0 0,30 * * * *",
    exchangeContractAddress: "0x0900000000000000000000000000000000000006",
    exchangeSchedule: "0 5,15,25,35,45,55 * * * *",
    keeperContractAddress: "0x0900000000000000000000000000000000000007",
    keeperSchedule: "0 2,12,22,32,42,52 * * * *",
  }
  const fns = (extra: Record<string, string>) =>
    initWorkflow({ ...base, ...extra } as Config).map((h) => h.fn)

  test("is appended after the keeper, moving no existing index", () => {
    const withScheduler = fns({
      schedulerContractAddress: "0x0900000000000000000000000000000000000008",
      schedulerSchedule: "0 1 * * * *",
    })
    const without = fns({})
    expect(withScheduler.slice(0, without.length)).toEqual(without)
    expect(without.at(-1)).toBe(onRequestDue)
    expect(withScheduler.at(-1)).toBe(onScheduleMarkets)
    expect(withScheduler).toHaveLength(without.length + 1)
  })

  test("is not registered without a schedule, or with the zero address", () => {
    expect(fns({ schedulerContractAddress: "0x0900000000000000000000000000000000000008" })).not.toContain(
      onScheduleMarkets,
    )
    expect(
      fns({ schedulerContractAddress: "0x0000000000000000000000000000000000000000", schedulerSchedule: "0 1 * * * *" }),
    ).not.toContain(onScheduleMarkets)
  })
})

/**
 * Football. One request per run is reduced to a digest every node agrees on;
 * from it and DON time come the results to report and the next match to open.
 * The rules worth pinning: the answer is the score after NINETY minutes, a
 * postponement voids, a result is never reported before the match could have
 * ended, and opening is bounded and soonest-first.
 */
describe("football", () => {
  const KICKOFF = Date.UTC(2026, 9, 24, 14, 0, 0) / 1000
  const match = (over: Partial<FootballMatch> = {}): FootballMatch => ({
    id: 537000,
    kickoff: KICKOFF,
    status: "FINISHED",
    competition: "PL",
    home: "Arsenal",
    away: "Chelsea",
    homeGoals: 2,
    awayGoals: 1,
    ...over,
  })
  const apiMatch = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    utcDate: "2026-10-24T14:00:00Z",
    status: "FINISHED",
    lastUpdated: `2026-10-24T16:0${id % 10}:00Z`,
    competition: { code: "CL", name: "UEFA Champions League" },
    homeTeam: { shortName: "Real Madrid", name: "Real Madrid CF" },
    awayTeam: { shortName: "Bayern", name: "FC Bayern München" },
    score: { winner: "AWAY_TEAM", duration: "REGULAR", fullTime: { home: 1, away: 2 }, halfTime: { home: 0, away: 1 } },
    ...over,
  })

  test("the digest keeps what decides a market, sorted, and drops what nodes disagree on", () => {
    const a = footballDigest({ matches: [apiMatch(2), apiMatch(1)] })
    const b = footballDigest({ matches: [apiMatch(1, { lastUpdated: "later" }), apiMatch(2)] })
    expect(a).toBe(b)
    const [first] = JSON.parse(a) as FootballMatch[]
    expect(first).toEqual({
      id: 1,
      kickoff: KICKOFF,
      status: "FINISHED",
      competition: "CL",
      home: "Real Madrid",
      away: "Bayern",
      homeGoals: 1,
      awayGoals: 2,
    })
  })

  test("a status the API answers as a timestamp reads as scheduled", () => {
    // Measured 2026-10-20 with competitions=PL,CL on the free plan.
    const [m] = JSON.parse(
      footballDigest({ matches: [apiMatch(4, { status: "2026-10-21 15:45:00Z", score: { fullTime: { home: null, away: null } } })] }),
    ) as FootballMatch[]
    expect(m!.status).toBe("SCHEDULED")
  })

  test("after extra time, the score that counts is the one at ninety minutes", () => {
    const [m] = JSON.parse(
      footballDigest({
        matches: [
          apiMatch(3, {
            score: { winner: "HOME_TEAM", duration: "EXTRA_TIME", fullTime: { home: 2, away: 1 }, regularTime: { home: 1, away: 1 } },
          }),
        ],
      }),
    ) as FootballMatch[]
    expect(footballResult(m, KICKOFF, KICKOFF + 3 * 3600)).toBe(SPORTS_DRAW)
  })

  test("a finished match resolves home, draw or away", () => {
    const later = KICKOFF + 3 * 3600
    expect(footballResult(match({ homeGoals: 2, awayGoals: 1 }), KICKOFF, later)).toBe(SPORTS_HOME)
    expect(footballResult(match({ homeGoals: 1, awayGoals: 1 }), KICKOFF, later)).toBe(SPORTS_DRAW)
    expect(footballResult(match({ homeGoals: 0, awayGoals: 3 }), KICKOFF, later)).toBe(SPORTS_AWAY)
  })

  test("nothing is reported before the match could have ended, except a postponement", () => {
    expect(footballResult(match(), KICKOFF, KICKOFF + 3600)).toBeNull()
    expect(footballResult(match({ status: "POSTPONED", homeGoals: null, awayGoals: null }), KICKOFF, KICKOFF - 86400)).toBe(
      SPORTS_VOID,
    )
  })

  test("in play or missing waits; days later it voids rather than holding money for ever", () => {
    const soon = KICKOFF + 3 * 3600
    const days = KICKOFF + 4 * 86400
    expect(footballResult(match({ status: "IN_PLAY", homeGoals: null, awayGoals: null }), KICKOFF, soon)).toBeNull()
    expect(footballResult(undefined, KICKOFF, soon)).toBeNull()
    expect(footballResult(undefined, KICKOFF, days)).toBe(SPORTS_VOID)
    expect(footballResult(match({ status: "SUSPENDED" }), KICKOFF, soon)).toBe(SPORTS_VOID)
  })

  test("opens scheduled matches in the chosen competitions, far enough out, soonest first", () => {
    const now = KICKOFF - 86400
    const list = [
      match({ id: 1, status: "TIMED", kickoff: now + 2 * 86400 }),
      match({ id: 2, status: "TIMED", kickoff: now + 6 * 3600 }),
      match({ id: 3, status: "TIMED", kickoff: now + 3600 }), // too close
      match({ id: 4, status: "TIMED", kickoff: now + 5 * 86400 }), // too far
      match({ id: 5, status: "TIMED", competition: "BSA", kickoff: now + 6 * 3600 }), // not chosen
      match({ id: 6, status: "FINISHED", kickoff: now + 6 * 3600 }),
      match({ id: 7, status: "TIMED", kickoff: now + 8 * 3600 }), // already open
    ]
    expect(footballToOpen(list, ["PL", "CL"], new Set([7]), now, 5).map((m) => m.id)).toEqual([2, 1])
    expect(footballToOpen(list, ["PL", "CL"], new Set([7]), now, 1).map((m) => m.id)).toEqual([2])
    expect(footballToOpen(list, ["PL", "CL"], new Set(), now, 0)).toEqual([])
  })

  test("encodes the report as SportsMarket decodes it", () => {
    const opens = [
      {
        matchId: 537000n,
        kickoff: BigInt(KICKOFF),
        competition: "PL",
        home: "Arsenal",
        away: "Chelsea",
        liquidity: 10_000_000n,
        openingBps: [4500, 2700, 2800] as [number, number, number],
        feeBps: 30,
      },
    ]
    const results = [{ matchId: 1n, result: SPORTS_AWAY, evidenceHash: `0x${"ab".repeat(32)}` as `0x${string}` }]
    const [o, r] = decodeAbiParameters(
      parseAbiParameters([
        "(uint64 matchId, uint64 kickoff, string competition, string home, string away, uint256 liquidity, uint16[3] openingBps, uint16 feeBps)[]",
        "(uint64 matchId, uint8 result, bytes32 evidenceHash)[]",
      ]),
      encodeSportsReport(opens, results),
    )
    expect(o).toEqual(opens)
    expect(r).toEqual(results)
  })

  test("asks for Sepolia's gas: a match is three markets", () => {
    expect(Number(sportsGasLimit(1, 0))).toBeGreaterThanOrEqual(3_300_000)
    expect(Number(sportsGasLimit(0, 2))).toBeLessThan(Number(sportsGasLimit(1, 0)))
  })

  test("rides on the scheduler's trigger: a workflow may have at most ten", () => {
    const base = {
      flightContractAddress: "0x0900000000000000000000000000000000000001",
      chainSelectorName: "ethereum-testnet-sepolia",
      apiUrl: "https://example.invalid",
      apiKey: "unused",
      gasLimit: "1000000",
      cryptoContractAddress: "0x0900000000000000000000000000000000000002",
      stockContractAddress: "0x0900000000000000000000000000000000000003",
      reserveContractAddress: "0x0900000000000000000000000000000000000004",
      sweepSchedule: "0 0,30 * * * *",
      exchangeContractAddress: "0x0900000000000000000000000000000000000006",
      exchangeSchedule: "0 5,15,25,35,45,55 * * * *",
      keeperContractAddress: "0x0900000000000000000000000000000000000007",
      keeperSchedule: "0 2,12,22,32,42,52 * * * *",
      schedulerContractAddress: "0x0900000000000000000000000000000000000008",
      schedulerSchedule: "0 1,31 * * * *",
    }
    const fns = (extra: Record<string, string>) => initWorkflow({ ...base, ...extra } as Config).map((h) => h.fn)
    const withSports = fns({ sportsContractAddress: "0x0900000000000000000000000000000000000009", sportsSchedule: "0 15 * * * *" })
    expect(withSports).toHaveLength(10)
    expect(withSports.at(-1)).toBe(onScheduleCycle)
    expect(fns({}).at(-1)).toBe(onScheduleMarkets)
    // Without the scheduler, football has a trigger of its own.
    const { schedulerContractAddress: _s, ...noScheduler } = base
    const alone = initWorkflow({ ...noScheduler, sportsContractAddress: "0x0900000000000000000000000000000000000009", sportsSchedule: "0 15 * * * *" } as Config).map((h) => h.fn)
    expect(alone.at(-1)).toBe(onSportsCycle)
  })
})
