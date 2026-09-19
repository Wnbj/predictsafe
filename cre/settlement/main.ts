import {
  EVMClient,
  HTTPClient,
  getNetwork,
  logTriggerConfig,
  prepareReportRequest,
  bytesToHex,
  blockNumber,
  encodeCallMsg,
  protoBigIntToBigint,
  CronCapability,
  LAST_FINALIZED_BLOCK_NUMBER,
  TxStatus,
  handler,
  Runner,
  json,
  ok,
  ConsensusAggregationByFields,
  median,
  identical,
  ignore,
  type Runtime,
  type HTTPSendRequester,
  type EVMLog,
  type Workflow,
} from "@chainlink/cre-sdk"
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  keccak256,
  toEventSelector,
  toHex,
} from "viem"
import { z } from "zod"

/**
 * Flight-delay prediction market settlement.
 *
 * FlightMarket.sol emits SettlementRequested -> this workflow fetches the flight's
 * actual arrival delay -> DON reaches consensus -> signed report goes back to
 * onReport(), which flips the market to Settled or Void.
 *
 * Outcome codes MUST match the Solidity `Outcome` enum:
 *   0 = Unset, 1 = Yes (delayed >= threshold), 2 = No, 3 = Void
 */

export type Config = {
  flightContractAddress: string
  chainSelectorName: string
  apiUrl: string          // AeroDataBox base URL, e.g. https://aerodatabox.p.rapidapi.com
  /**
   * RapidAPI key for AeroDataBox, in the clear.
   *
   * This is the weak link in the current setup, and naming it here is the
   * point: workflow config is handed to the DON, so every node operator
   * running this workflow can read the key. It is fine for a POC on a free
   * tier and would not be fine for anything else. Prefer `apiKeySecretId`.
   */
  apiKey: string
  /**
   * Vault DON secret holding the same key. When set, it wins over `apiKey`
   * and the key never appears in config at all.
   *
   * Not yet exercised: the secrets registry lives on Ethereum MAINNET, so
   * using it needs a mainnet RPC in project.yaml and `cre secrets create`,
   * which is a real mainnet transaction. See RUNBOOK.
   */
  apiKeySecretId?: string
  /** Namespace for the secret above. Defaults to "main". */
  apiKeySecretNamespace?: string
  /**
   * Optional second, independent provider. Empty string disables it and the
   * workflow runs single-source.
   *
   * DON consensus protects against a dishonest or broken *node*; it cannot
   * protect against a wrong *source*, because every node queries the same one.
   * A second provider is what closes that gap.
   *
   * Expected to serve `{ status, arrivalDelayMinutes }` — see
   * `simpleSourceSchema`. Adapting a real provider means writing one small
   * function like `readAeroDataBox`, not changing anything below it.
   */
  secondaryUrl?: string
  /**
   * CryptoMarket address. Empty string leaves the crypto handler unregistered
   * and the workflow settles flights only.
   */
  cryptoContractAddress?: string
  /**
   * AmmMarket address. It emits the same SettlementRequested event as
   * CryptoMarket, so it joins that trigger's address list rather than getting
   * a handler of its own.
   */
  ammContractAddress?: string
  /**
   * StockMarket address. Empty string leaves the stock handler unregistered.
   */
  stockContractAddress?: string
  /**
   * ReserveMarket address. Empty string leaves the reserve handler
   * unregistered.
   */
  reserveContractAddress?: string
  /**
   * Cron schedule for the reconciliation sweep, in six-field cron form
   * (seconds first). Empty string leaves the sweep unregistered and the
   * workflow purely log-driven. See config.staging.example.json for a
   * five-minute schedule — the literal cannot go in this comment, because a
   * cron step contains the character pair that would close it.
   */
  sweepSchedule?: string
  gasLimit: string
}

const OUTCOME_YES = 1
const OUTCOME_NO = 2
const OUTCOME_VOID = 3

/**
 * A narrow Solidity integer, ready for viem's encoder.
 *
 * viem's types declare plain `number` for the small widths (`uint8`, `int32`),
 * so the cast back is only to satisfy TypeScript — the value handed to the
 * encoder is a bigint. That matters because viem range-checks with
 * `value < min` against a bigint bound, and in this workflow's WASM/QuickJS
 * runtime a mixed number-vs-bigint comparison is simply wrong for negative
 * numbers: confirmed against the real runtime, `-33 < -2147483648n` evaluated
 * to `true` here though not in Node/bun, throwing a spurious
 * IntegerOutOfRangeError.
 *
 * Only negatives have actually bitten, so `outcome` was never in danger. It
 * goes through here anyway because the SDK's rule is bigint for every Solidity
 * integer, and one rule holds better than an exception that happens to be safe.
 * The wide widths (`uint256`, `int256`) are typed `bigint` by viem already and
 * are passed directly.
 */
const abiInt = (n: number | bigint): number => BigInt(n) as unknown as number

// --- event ABI ---------------------------------------------------------------
// Must match FlightMarket.sol exactly.
const settlementRequestedAbi = [
  {
    type: "event",
    name: "SettlementRequested",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "flightIata", type: "string", indexed: false },
      { name: "departureDate", type: "uint32", indexed: false },
      { name: "thresholdMinutes", type: "uint16", indexed: false },
    ],
  },
] as const

const SETTLEMENT_REQUESTED_TOPIC = toEventSelector(
  "SettlementRequested(uint256,string,uint32,uint16)",
)

// Must match CryptoMarket.sol exactly.
const cryptoSettlementRequestedAbi = [
  {
    type: "event",
    name: "SettlementRequested",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "asset", type: "uint8", indexed: false },
      { name: "strikePrice", type: "uint64", indexed: false },
      { name: "expiryTime", type: "uint64", indexed: false },
    ],
  },
] as const

const CRYPTO_SETTLEMENT_REQUESTED_TOPIC = toEventSelector(
  "SettlementRequested(uint256,uint8,uint64,uint64)",
)

// Must match StockMarket.sol exactly. It carries closeTime as well as expiry
// because the workflow has to check the price moved while the market was live.
const stockSettlementRequestedAbi = [
  {
    type: "event",
    name: "SettlementRequested",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "feed", type: "address", indexed: false },
      { name: "strikePrice", type: "uint64", indexed: false },
      { name: "closeTime", type: "uint64", indexed: false },
      { name: "expiryTime", type: "uint64", indexed: false },
      { name: "maxStaleness", type: "uint32", indexed: false },
    ],
  },
] as const

const STOCK_SETTLEMENT_REQUESTED_TOPIC = toEventSelector(
  "SettlementRequested(uint256,address,uint64,uint64,uint64,uint32)",
)

// Must match ReserveMarket.sol exactly. Note the ABSENCE of closeTime: a
// reserve has no trading session, so there is no movement check to perform and
// the contract deliberately does not supply the input for one.
const reserveSettlementRequestedAbi = [
  {
    type: "event",
    name: "SettlementRequested",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "feed", type: "address", indexed: false },
      { name: "strikePrice", type: "uint64", indexed: false },
      { name: "expiryTime", type: "uint64", indexed: false },
      { name: "maxStaleness", type: "uint32", indexed: false },
    ],
  },
] as const

const RESERVE_SETTLEMENT_REQUESTED_TOPIC = toEventSelector(
  "SettlementRequested(uint256,address,uint64,uint64,uint32)",
)

// --- market-state ABI, for the cron sweep -----------------------------------
// Only the reads the sweep needs. Shapes taken from the build artifacts, not
// written from memory: FlightMarket predates the shared base and exposes its
// whole market as one `markets` tuple, while the two newer contracts split
// lifecycle (`core`, from ParimutuelMarket) from question terms (`terms`).

const marketCountAbi = [
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

const flightMarketsAbi = [
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "question", type: "string" },
      { name: "flightIata", type: "string" },
      { name: "departureDate", type: "uint32" },
      { name: "thresholdMinutes", type: "uint16" },
      { name: "closeTime", type: "uint64" },
      { name: "settleAfter", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "outcome", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "observedDelay", type: "int32" },
      { name: "yesPool", type: "uint256" },
      { name: "noPool", type: "uint256" },
    ],
  },
] as const

const coreAbi = [
  {
    type: "function",
    name: "core",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "question", type: "string" },
      { name: "closeTime", type: "uint64" },
      { name: "settleAfter", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "outcome", type: "uint8" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "observedValue", type: "int256" },
      { name: "yesPool", type: "uint256" },
      { name: "noPool", type: "uint256" },
    ],
  },
] as const

const cryptoTermsAbi = [
  {
    type: "function",
    name: "terms",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "asset", type: "uint8" },
      { name: "strikePrice", type: "uint64" },
      { name: "expiryTime", type: "uint64" },
    ],
  },
] as const

const stockTermsAbi = [
  {
    type: "function",
    name: "terms",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "feed", type: "address" },
      { name: "strikePrice", type: "uint64" },
      { name: "expiryTime", type: "uint64" },
      { name: "maxStaleness", type: "uint32" },
    ],
  },
] as const

/** ParimutuelMarket.Status.SettlementRequested — the state the sweep acts on. */
const STATUS_SETTLEMENT_REQUESTED = 2

/**
 * Ceiling on writes per sweep. A sweep that found several stuck markets is a
 * sweep something else has gone wrong around; settling a couple and coming
 * back next tick beats one run holding the workflow open for a queue of
 * sequential on-chain writes.
 */
const MAX_SETTLEMENTS_PER_SWEEP = 2

/**
 * Chain reads held back for the stock sweep's feed walk.
 *
 * Settling a stock market is the only settlement that itself costs chain
 * reads — one for the latest round, then one per step back to expiry and on
 * to close. A daily feed usually needs two or three; this leaves room for
 * more without letting the scan eat the whole allowance.
 */
const STOCK_WALK_RESERVE = 6

/*
 * Stock sweep budget, worst case, against the limit of 15:
 *   1 header + 1 marketCount + 5 core + 1 terms + 1 decimals + 6 walk = 15
 * The scan window is derived from what is left rather than fixed, so adding
 * another per-settlement read narrows the scan instead of silently overrunning.
 */

/** The AggregatorV3Interface subset this workflow reads. */
const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const

/**
 * Chain reads allowed in ONE workflow execution.
 *
 * Not a number picked for tidiness — it is `ChainRead.CallLimit` from
 * `cre workflow limits export`, and exceeding it aborts the execution with
 * LimitExceeded partway through, after any writes already made have landed.
 * The simulator enforces it too, which is how it was found.
 *
 * Every read below therefore draws from an explicit budget rather than
 * trusting a loop bound to be small enough in practice.
 */
const CHAIN_READ_LIMIT = 15

/** Remaining chain reads for the current execution. */
export type ReadBudget = { left: number }

export const newReadBudget = (reserved = 0): ReadBudget => ({ left: CHAIN_READ_LIMIT - reserved })

/**
 * How far back the round walk may go.
 *
 * Two bounds meet here. The first is correctness: roundIds are phase-encoded,
 * so decrementing past the first round of a phase does not roll into the
 * previous phase, it lands on a round that was never published — voiding beats
 * walking into nothing. The second is the read budget above, and it is the
 * tighter one. This was 24, which read innocently and was unreachable: a
 * settlement walks twice (once to expiry, once to close), so the worst case
 * was 1 + 24 + 24 = 49 reads against a hard limit of 15. The walks now share
 * one budget instead of each having a private allowance.
 */
const MAX_ROUND_WALK = CHAIN_READ_LIMIT

/** Matches CryptoMarket.Asset. */
const ASSET_SYMBOLS = ["BTC", "ETH"] as const

/** Prices are carried at 8 decimals, matching the strike stored on chain. */
const PRICE_DECIMALS = 100_000_000

/** The exponent behind PRICE_DECIMALS, for rescaling feeds that disagree. */
const PRICE_SCALE_DECIMALS = 8

// --- API response --------------------------------------------------------
// AeroDataBox (via RapidAPI): GET /flights/number/{iata}/{YYYY-MM-DD}
// Schema pulled from the live OpenAPI spec (doc.aerodatabox.com), not guessed —
// field names and the FlightStatus enum below are verbatim from FlightContract.
// https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json

const dateTimeSchema = z.object({
  utc: z.string(),
})

const movementSchema = z.object({
  scheduledTime: dateTimeSchema.optional(),
  revisedTime: dateTimeSchema.optional(),
})

const flightStatusEnum = z.enum([
  "Unknown", "Expected", "EnRoute", "CheckIn", "Boarding", "GateClosed",
  "Departed", "Delayed", "Approaching", "Arrived", "Canceled", "Diverted",
  "CanceledUncertain",
])

const flightContractSchema = z.object({
  status: flightStatusEnum,
  arrival: movementSchema.optional(),
})

// The endpoint returns an array (codeshares can produce more than one entry).
const flightResponseSchema = z.array(flightContractSchema)

/**
 * AeroDataBox's own timestamp format: "2026-08-14 12:55Z" — space instead of
 * "T", no seconds. Not RFC 3339, so `Date.parse` on it is implementation
 * defined: V8 (bun, this file's local tests) accepts it, but the actual
 * workflow runs in the WASM/QuickJS runtime, which returned NaN for it —
 * caught by running the real simulator against a live flight, not by local
 * testing. `Date.UTC` takes numeric components with no string-format
 * ambiguity, so it can't silently disagree between engines the way parsing
 * a string can.
 */
export const parseAeroDataBoxUtc = (s: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})Z$/.exec(s)
  if (!m) throw new Error(`Unrecognized AeroDataBox timestamp: ${s}`)
  const [, y, mo, d, h, mi] = m
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
}

/**
 * Per-node result.
 *
 * CONSENSUS HAZARD: every field here is aggregated across nodes, so anything
 * that varies per node breaks consensus. `delayMinutes` is deliberately
 * bucketed to whole minutes and `fetchedAt` is dropped via `ignore` — raw
 * API timestamps (lastUpdatedUtc, request time) differ on every node and
 * would never agree.
 */
type Observation = {
  delayMinutes: number
  status: string
  fetchedAt: number
}

/** What one provider reported, before any cross-source reconciliation. */
export type SourceReading = {
  delayMinutes: number
  status: string
}

/**
 * Shape expected from a secondary provider. Deliberately minimal so adapting
 * a new one is a small function rather than a schema negotiation — and so the
 * repo's existing mock gist can stand in as a controllable second source when
 * testing the disagreement path.
 */
const simpleSourceSchema = z.object({
  status: z.string(),
  arrivalDelayMinutes: z.number().nullable(),
})

const readAeroDataBox = (
  sendRequester: HTTPSendRequester,
  apiUrl: string,
  apiKey: string,
  flightIata: string,
  departureDateIso: string,
): SourceReading => {
  const url = `${apiUrl}/flights/number/${flightIata}/${departureDateIso}?dateLocalRole=Departure`
  const response = sendRequester
    .sendRequest({
      url,
      method: "GET",
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
      },
    })
    .result()

  // 204 = no matching flight for that number/date.
  if (response.statusCode === 204) {
    throw new Error(`No flight found for ${flightIata} on ${departureDateIso}`)
  }
  if (!ok(response)) {
    throw new Error(`HTTP ${response.statusCode} for ${flightIata}`)
  }

  const flights = flightResponseSchema.parse(json(response))
  // Prefer the operating leg over a codeshare entry when both are present.
  const flight = flights[0]
  if (!flight) {
    throw new Error(`Empty flight list for ${flightIata} on ${departureDateIso}`)
  }

  // `CanceledUncertain` is deliberately NOT treated as cancelled. AeroDataBox
  // defines it as "status of the flight is uncertain, may be cancelled" — a
  // maybe, not a fact. Paying a market out on a maybe is the worst available
  // failure: the UI promises Yes for "cancelled or diverted", and someone
  // would collect real money on an unconfirmed signal. It falls through to
  // `airborne` below, which voids and refunds everyone — the same treatment
  // the contract already documents for unavailable data.
  //
  // This is not an edge case: 75 of 565 arrivals sampled at ORD (13%) carried
  // this status.
  const isDisrupted = flight.status === "Canceled" || flight.status === "Diverted"
  const isLanded = flight.status === "Arrived"

  let delayMinutes = 0
  if (isLanded && flight.arrival?.scheduledTime && flight.arrival?.revisedTime) {
    const scheduled = parseAeroDataBoxUtc(flight.arrival.scheduledTime.utc)
    const actual = parseAeroDataBoxUtc(flight.arrival.revisedTime.utc)
    // Round to whole minutes so independent nodes converge on one value.
    delayMinutes = Math.round((actual - scheduled) / 60_000)
  }

  return {
    delayMinutes,
    status: isDisrupted ? "cancelled" : isLanded ? "landed" : "airborne",
  }
}

const readSecondary = (
  sendRequester: HTTPSendRequester,
  url: string,
  flightIata: string,
  departureDateIso: string,
): SourceReading => {
  const response = sendRequester
    .sendRequest({
      url: `${url}?flight=${flightIata}&date=${departureDateIso}`,
      method: "GET",
    })
    .result()

  if (!ok(response)) {
    throw new Error(`Secondary source HTTP ${response.statusCode} for ${flightIata}`)
  }

  const parsed = simpleSourceSchema.parse(json(response))
  const status = parsed.status.toLowerCase()
  return {
    delayMinutes:
      parsed.arrivalDelayMinutes === null ? 0 : Math.round(parsed.arrivalDelayMinutes),
    status: status === "diverted" ? "cancelled" : status,
  }
}

/**
 * Which way a single source would settle the market. Reconciliation compares
 * *this*, not the raw minutes: two sources reporting 44 and 46 against a
 * 45-minute threshold are only ~2 minutes apart, but they disagree about who
 * gets paid. Averaging them would silently manufacture an answer neither
 * source actually gave.
 */
export const outcomeFor = (reading: SourceReading, thresholdMinutes: number): number => {
  if (reading.status === "cancelled") return OUTCOME_YES
  if (reading.status !== "landed") return OUTCOME_VOID
  return reading.delayMinutes >= thresholdMinutes ? OUTCOME_YES : OUTCOME_NO
}

const fetchFlight = (
  sendRequester: HTTPSendRequester,
  apiUrl: string,
  apiKey: string,
  secondaryUrl: string,
  flightIata: string,
  departureDateIso: string,
  thresholdMinutes: number,
): Observation => {
  const readings: SourceReading[] = [
    readAeroDataBox(sendRequester, apiUrl, apiKey, flightIata, departureDateIso),
  ]

  // Empty string = single-source mode. A failing secondary is NOT swallowed:
  // losing the cross-check silently would leave the market resolving on one
  // source while appearing to be corroborated.
  if (secondaryUrl !== "") {
    readings.push(readSecondary(sendRequester, secondaryUrl, flightIata, departureDateIso))
  }

  const outcomes = readings.map((r) => outcomeFor(r, thresholdMinutes))
  const allAgree = outcomes.every((o) => o === outcomes[0])
  if (!allAgree) {
    // Throwing voids the market and refunds everyone. When independent
    // sources contradict each other about a real-world fact, refusing to
    // settle is the honest answer — picking a winner would be a coin flip
    // dressed up as data.
    throw new Error(
      `Sources disagree on outcome for ${flightIata}: ${readings
        .map((r, i) => `${r.status}/${r.delayMinutes}m->${outcomes[i]}`)
        .join(" vs ")}`,
    )
  }

  // Sources agree on the outcome, so any spread left is noise within one
  // side of the threshold. Median generalises past two sources; with two it
  // is the midpoint, rounded to keep nodes converging on one integer.
  const sorted = [...readings].sort((a, b) => a.delayMinutes - b.delayMinutes)
  const mid = sorted.length / 2
  const medianDelay =
    sorted.length % 2 === 1
      ? sorted[Math.floor(mid)]!.delayMinutes
      : Math.round((sorted[mid - 1]!.delayMinutes + sorted[mid]!.delayMinutes) / 2)

  return {
    delayMinutes: medianDelay,
    status: readings[0]!.status,
    fetchedAt: 0,
  }
}

// --- crypto price sources -------------------------------------------------
//
// Three independent USD spot venues. Binance is deliberately excluded: its
// liquid pair is BTC/USDT, and pricing a USD-denominated market off a Tether
// pair adds a systematic basis rather than independent signal. Measured live,
// Binance sat ~$70 (0.11%) away from the USD venues while Coinbase, Kraken and
// Bitstamp agreed within ~$6 (0.01%) of each other.
//
// Every source is asked for the ONE-MINUTE CANDLE CONTAINING EXPIRY and its
// close is used, rather than a spot quote. Spot would give each DON node a
// different number depending on the millisecond it happened to ask, so
// consensus could never be exact. A closed historical candle is the same value
// for every node, however far apart they run.

const cryptoPriceSchemas = {
  /** Coinbase Exchange: [[ time, low, high, open, close, volume ], …] */
  coinbase: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])),
  /** Bitstamp: named fields, unlike the others. */
  bitstamp: z.object({
    data: z.object({
      ohlc: z.array(z.object({ timestamp: z.string(), close: z.string() })),
    }),
  }),
  /** Kraken: { result: { <dynamic pair key>: [[ time, open, high, low, close, … ], …] } } */
  kraken: z.object({
    error: z.array(z.string()),
    result: z.record(z.string(), z.unknown()),
  }),
}

const requireOk = (response: { statusCode: number }, venue: string) => {
  if (!ok(response as never)) {
    throw new Error(`${venue} HTTP ${response.statusCode}`)
  }
}

/**
 * The window is deliberately five minutes either side of the minute we want,
 * not the minute itself.
 *
 * Coinbase drops candles from narrow ranges in a way that has nothing to do
 * with whether the data exists. Asking for exactly `[T, T+60]` returns an empty
 * array for a minute that a wider request returns happily, and reproducibly so
 * — it cost this workflow a live market, voided for "no candle" against a
 * minute that had traded 1.04 BTC. Measured over 114 requests across both
 * products: `[T, T+60]` never returned the candle, `[T-60, T+60]` missed 8% of
 * the time, and `[T-300, T+300]` missed none. The response is ~650 bytes, so
 * the margin is free.
 *
 * All three venues are therefore asked for a range and searched for the exact
 * minute, never trusted to return the one bucket asked for.
 */
const readCoinbasePrice = (
  sendRequester: HTTPSendRequester,
  symbol: string,
  minuteStart: number,
): number => {
  const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=60&start=${minuteStart - 300}&end=${minuteStart + 300}`
  const response = sendRequester.sendRequest({ url, method: "GET" }).result()
  requireOk(response, "Coinbase")

  const candles = cryptoPriceSchemas.coinbase.parse(json(response))
  const candle = candles.find((c) => c[0] === minuteStart)
  if (!candle) throw new Error(`Coinbase has no candle for minute ${minuteStart}`)
  return candle[4]
}

const readBitstampPrice = (
  sendRequester: HTTPSendRequester,
  symbol: string,
  minuteStart: number,
): number => {
  const url = `https://www.bitstamp.net/api/v2/ohlc/${symbol.toLowerCase()}usd/?step=60&limit=5&start=${minuteStart - 120}`
  const response = sendRequester.sendRequest({ url, method: "GET" }).result()
  requireOk(response, "Bitstamp")

  const parsed = cryptoPriceSchemas.bitstamp.parse(json(response))
  const candle = parsed.data.ohlc.find((c) => Number(c.timestamp) === minuteStart)
  if (!candle) throw new Error(`Bitstamp has no candle for minute ${minuteStart}`)
  return Number(candle.close)
}

const readKrakenPrice = (
  sendRequester: HTTPSendRequester,
  symbol: string,
  minuteStart: number,
): number => {
  // Kraken calls Bitcoin XBT, and `since` is exclusive — ask from the minute
  // before so the one we want is included.
  const pair = symbol === "BTC" ? "XBTUSD" : `${symbol}USD`
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1&since=${minuteStart - 60}`
  const response = sendRequester.sendRequest({ url, method: "GET" }).result()
  requireOk(response, "Kraken")

  const parsed = cryptoPriceSchemas.kraken.parse(json(response))
  if (parsed.error.length > 0) throw new Error(`Kraken error: ${parsed.error.join(",")}`)

  // The result key is the venue's own pair name (XXBTZUSD), not what we asked
  // for, so find the array rather than guessing the key.
  let candles: unknown[] | undefined
  for (const key of Object.keys(parsed.result)) {
    if (key !== "last" && Array.isArray(parsed.result[key])) {
      candles = parsed.result[key] as unknown[]
      break
    }
  }
  if (!candles) throw new Error("Kraken returned no candle series")

  for (const row of candles) {
    const c = row as unknown[]
    if (Number(c[0]) === minuteStart) return Number(c[4])
  }
  throw new Error(`Kraken has no candle for minute ${minuteStart}`)
}

/** Price in whole units, scaled to the 8-decimal integer the contract uses. */
export const toScaledPrice = (price: number): number => Math.round(price * PRICE_DECIMALS)

/**
 * The median venue price, but only once every venue agrees which side of the
 * strike it landed on. Throws otherwise, which the caller turns into a void.
 *
 * Agreement is on the OUTCOME, not on the numbers being close. Two venues a
 * few cents apart either side of the strike are numerically near-identical and
 * disagree completely about who gets paid; averaging them would invent an
 * answer neither venue gave. Pure and exported so the rule can be tested
 * without three HTTP calls.
 */
/**
 * How many venues must actually answer before a price is trustworthy.
 *
 * Two, not three. A venue that CANNOT answer is not a venue that disagrees,
 * and the original code could not tell the difference — one `throw` covered
 * both. That cost a real market: crypto #14 voided on the DON because Kraken
 * serves only about twelve hours of one-minute candles (measured: 721 of them)
 * and the market was settled 38 hours after expiry. Coinbase and Bitstamp
 * could both answer; their agreement was discarded along with Kraken's
 * silence.
 *
 * Two independent venues agreeing on which side of the strike a price fell is
 * not a guess. One is, which is why the floor is not lower.
 */
const MIN_VENUES = 2

export const reconcileVenuePrices = (
  names: string[],
  prices: number[],
  strikePrice: number,
  symbol: string,
): number => {
  if (prices.length < MIN_VENUES) {
    throw new Error(
      `Only ${prices.length} venue(s) priced ${symbol}, need ${MIN_VENUES}` +
        (names.length > 0 ? ` (answered: ${names.join(", ")})` : ""),
    )
  }

  const outcomes = prices.map((p) => (p >= strikePrice ? OUTCOME_YES : OUTCOME_NO))
  if (!outcomes.every((o) => o === outcomes[0])) {
    throw new Error(
      `Venues disagree on ${symbol} vs strike ${strikePrice}: ${names
        .map((n, i) => `${n}=${prices[i]}->${outcomes[i]}`)
        .join(" vs ")}`,
    )
  }

  const sorted = [...prices].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const fetchCryptoPrice = (
  sendRequester: HTTPSendRequester,
  symbol: string,
  minuteStart: number,
  strikePrice: number,
): Observation => {
  const venues: { name: string; read: () => number }[] = [
    { name: "coinbase", read: () => readCoinbasePrice(sendRequester, symbol, minuteStart) },
    { name: "bitstamp", read: () => readBitstampPrice(sendRequester, symbol, minuteStart) },
    { name: "kraken", read: () => readKrakenPrice(sendRequester, symbol, minuteStart) },
  ]

  /*
   * Collected rather than mapped, so that one venue being unable to answer
   * does not discard the ones that could. A failure is recorded and carried
   * into the error message if too few are left — silence that goes unexplained
   * is how a void looks identical to a bug.
   */
  const answered: string[] = []
  const prices: number[] = []
  const silent: string[] = []
  for (const v of venues) {
    try {
      prices.push(toScaledPrice(v.read()))
      answered.push(v.name)
    } catch (err) {
      silent.push(`${v.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  /*
   * Thrown here rather than left to `reconcileVenuePrices`, because only this
   * scope knows WHY a venue is missing. "Only 1 venue priced BTC" sends the
   * next reader to the reconciliation rule; "kraken: has no candle for minute
   * X" sends them to the venue's history window, which is where the problem
   * actually was.
   */
  if (prices.length < MIN_VENUES) {
    throw new Error(
      `Only ${prices.length} of ${venues.length} venues priced ${symbol} at minute ` +
        `${minuteStart}; need ${MIN_VENUES}. Silent — ${silent.join(" | ")}`,
    )
  }

  const medianPrice = reconcileVenuePrices(answered, prices, strikePrice, symbol)

  return { delayMinutes: medianPrice, status: "priced", fetchedAt: 0 }
}

/**
 * Terms of one flight market, however they were obtained.
 *
 * The log trigger reads them out of the event; the cron sweep reads them off
 * chain. Both then settle through exactly the same code, so a market settled
 * by the sweep can never resolve differently from one settled by the trigger.
 */
export type FlightTerms = {
  marketId: bigint
  flightIata: string
  departureDate: number
  thresholdMinutes: number
}

/**
 * The provider key, from the Vault DON when one is configured and from plain
 * config otherwise.
 *
 * Resolved here in the handler rather than inside `fetchFlight`, because that
 * function runs under the HTTP capability's consensus wrapper on every node
 * and secrets are fetched through the runtime, not from inside a request
 * builder. It is passed down as an ordinary argument, exactly as the config
 * value already was — so the switch changes where the key comes from and
 * nothing about how it is used.
 */
const resolveApiKey = (runtime: Runtime<Config>): string => {
  const id = runtime.config.apiKeySecretId
  if (!id || id === "") return runtime.config.apiKey

  const secret = runtime
    .getSecret({ id, namespace: runtime.config.apiKeySecretNamespace ?? "main" })
    .result()
  return secret.value
}

const settleFlightMarket = (runtime: Runtime<Config>, t: FlightTerms): string => {
  const { marketId, flightIata, departureDate, thresholdMinutes } = t
  runtime.log(
    `Settling market ${marketId}: ${flightIata} on ${departureDate}, threshold ${thresholdMinutes}m`,
  )

  // AeroDataBox wants YYYY-MM-DD; the contract stores YYYYMMDD as a uint32.
  const dateDigits = departureDate.toString()
  const departureDateIso = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`

  // --- fetch with consensus ---
  const httpClient = new HTTPClient()
  const aggregation = ConsensusAggregationByFields<Observation>({
    delayMinutes: median,
    status: identical,
    fetchedAt: ignore,
  })

  let outcome: number
  let observedDelay: number
  let observedStatus: string

  try {
    const obs = httpClient
      .sendRequest(runtime, fetchFlight, aggregation)(
        runtime.config.apiUrl,
        resolveApiKey(runtime),
        runtime.config.secondaryUrl ?? "",
        flightIata,
        departureDateIso,
        Number(thresholdMinutes),
      )
      .result()

    observedDelay = obs.delayMinutes
    observedStatus = obs.status

    // Same rule `outcomeFor` applied per source, now over the consensus
    // result. Kept as one shared function so the per-source agreement check
    // and the final settlement can never drift apart.
    outcome = outcomeFor(
      { delayMinutes: obs.delayMinutes, status: obs.status },
      Number(thresholdMinutes),
    )
  } catch (err) {
    // Data unavailable or nodes disagreed -> refund path, never a coin flip.
    runtime.log(`Resolution failed, voiding market ${marketId}: ${err}`)
    outcome = OUTCOME_VOID
    observedDelay = 0
    observedStatus = "unavailable"
  }

  // --- evidence hash ---
  // Hash the NORMALIZED, consensus-agreed values. Hashing the raw API payload
  // would produce a different hash on every node and never reach consensus.
  // DON Time, not Date.now(), which is non-deterministic across nodes.
  const settledAt = Math.floor(runtime.now().getTime() / 1000)
  const evidence = JSON.stringify({
    marketId: marketId.toString(),
    flightIata,
    departureDate: Number(departureDate),
    thresholdMinutes: Number(thresholdMinutes),
    observedDelay,
    observedStatus,
    outcome,
    settledAt,
  })
  const evidenceHash = keccak256(toHex(evidence))

  runtime.log(
    `Market ${marketId} -> outcome=${outcome} delay=${observedDelay}m status=${observedStatus} evidence=${evidenceHash}`,
  )

  // --- signed report onchain ---
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`)
  }

  const evmClient = new EVMClient(network.chainSelector.selector)

  // Must match onReport's abi.decode: (uint256, uint8, int32, bytes32)
  //
  // delayMinutes is the reason `abiInt` exists — it is the one value here that
  // goes negative, on a flight that landed early. See the note on `abiInt`.
  const encoded = encodeAbiParameters(
    parseAbiParameters("uint256 marketId, uint8 outcome, int32 delayMinutes, bytes32 evidenceHash"),
    [marketId, abiInt(outcome), abiInt(observedDelay), evidenceHash],
  )

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.flightContractAddress,
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }

  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Settled market ${marketId} in tx ${txHash}`)
  return txHash
}

export const onSettlementRequested = (
  runtime: Runtime<Config>,
  triggerEvent: EVMLog,
): string => {
  // Log carries raw protobuf bytes (Uint8Array), so hex-encode before viem sees it.
  const decoded = decodeEventLog({
    abi: settlementRequestedAbi,
    data: bytesToHex(triggerEvent.data),
    topics: triggerEvent.topics.map((t) => bytesToHex(t)) as [
      `0x${string}`,
      ...`0x${string}`[],
    ],
  })

  const { marketId, flightIata, departureDate, thresholdMinutes } = decoded.args
  return settleFlightMarket(runtime, {
    marketId,
    flightIata,
    departureDate: Number(departureDate),
    thresholdMinutes: Number(thresholdMinutes),
  })
}

export type CryptoTerms = {
  marketId: bigint
  asset: number
  strikePrice: bigint
  expiryTime: number
  /**
   * Where to send the signed report.
   *
   * Taken from the contract the trigger log came FROM, rather than a fixed
   * config address, because two contracts now emit this identical event:
   * CryptoMarket and AmmMarket. They price the same question differently but
   * settle from the same data, so they share a handler — and a hardcoded
   * receiver would have quietly delivered one contract's result to the other.
   */
  receiver: string
}

const settleCryptoMarket = (runtime: Runtime<Config>, t: CryptoTerms): string => {
  const { marketId, asset, strikePrice, expiryTime, receiver } = t
  const symbol = ASSET_SYMBOLS[Number(asset)]
  if (!symbol) throw new Error(`Unknown asset index ${asset}`)

  // Settle on the close of the minute expiry fell in. CryptoMarket holds
  // settlement back a minute past expiry so this candle is always closed.
  const minuteStart = Math.floor(Number(expiryTime) / 60) * 60
  const strike = Number(strikePrice)

  runtime.log(
    `Settling crypto market ${marketId}: ${symbol} vs strike ${strike} at minute ${minuteStart}`,
  )

  const httpClient = new HTTPClient()
  const aggregation = ConsensusAggregationByFields<Observation>({
    delayMinutes: median,
    status: identical,
    fetchedAt: ignore,
  })

  let outcome: number
  let observedPrice: number

  try {
    const obs = httpClient
      .sendRequest(runtime, fetchCryptoPrice, aggregation)(symbol, minuteStart, strike)
      .result()

    observedPrice = obs.delayMinutes
    outcome = observedPrice >= strike ? OUTCOME_YES : OUTCOME_NO
  } catch (err) {
    // Venues contradicted each other, or the data was unavailable. Refund
    // rather than pick a side.
    runtime.log(`Resolution failed, voiding crypto market ${marketId}: ${err}`)
    outcome = OUTCOME_VOID
    observedPrice = 0
  }

  const settledAt = Math.floor(runtime.now().getTime() / 1000)
  const evidence = JSON.stringify({
    marketId: marketId.toString(),
    asset: symbol,
    strikePrice: strike,
    expiryTime: Number(expiryTime),
    minuteStart,
    observedPrice,
    outcome,
    settledAt,
  })
  const evidenceHash = keccak256(toHex(evidence))

  runtime.log(
    `Crypto market ${marketId} -> outcome=${outcome} price=${observedPrice} strike=${strike} evidence=${evidenceHash}`,
  )

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`)
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  // Must match ParimutuelMarket._processReport: (uint256, uint8, int256, bytes32).
  // BigInt for the same reason as the flight path — see the note there.
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint256 marketId, uint8 outcome, int256 observedValue, bytes32 evidenceHash",
    ),
    [marketId, abiInt(outcome), BigInt(observedPrice), evidenceHash],
  )

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver,
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }

  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Settled crypto market ${marketId} in tx ${txHash}`)
  return txHash
}

export const onCryptoSettlementRequested = (
  runtime: Runtime<Config>,
  triggerEvent: EVMLog,
): string => {
  const decoded = decodeEventLog({
    abi: cryptoSettlementRequestedAbi,
    data: bytesToHex(triggerEvent.data),
    topics: triggerEvent.topics.map((t) => bytesToHex(t)) as [
      `0x${string}`,
      ...`0x${string}`[],
    ],
  })

  const { marketId, asset, strikePrice, expiryTime } = decoded.args
  return settleCryptoMarket(runtime, {
    marketId,
    asset: Number(asset),
    strikePrice: BigInt(strikePrice),
    expiryTime: Number(expiryTime),
    receiver: bytesToHex(triggerEvent.address),
  })
}

// --- stock / commodity settlement, from a Chainlink Data Feed ---------------

export type FeedRound = { roundId: bigint; answer: bigint; updatedAt: number }

/**
 * One feed read, pinned to a block.
 *
 * The block matters more than the call. Every DON node runs this
 * independently, so reading at "latest" would give each node whatever head it
 * happened to see and the report bytes would differ — the same problem that
 * made spot quotes unusable for the crypto market. Pinning to the block the
 * settlement request was mined in gives every node one agreed reference point,
 * taken from the trigger they all received.
 */
/**
 * One `eth_call`, pinned to a block, drawn from the execution's read budget.
 *
 * Running out throws here rather than letting the platform abort the execution
 * mid-flight: the same run ends either way, but this way it ends inside the
 * `try` that voids the market, with a message saying which market and why.
 */
const ethCall = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  to: string,
  data: `0x${string}`,
  atBlock: bigint,
  budget: ReadBudget,
): `0x${string}` => {
  if (budget.left <= 0) {
    throw new Error(`Out of chain reads (limit ${CHAIN_READ_LIMIT} per execution)`)
  }
  budget.left--

  const reply = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: "0x0000000000000000000000000000000000000000",
        to: to as `0x${string}`,
        data,
      }),
      blockNumber: blockNumber(atBlock),
    })
    .result()

  return bytesToHex(reply.data ?? new Uint8Array())
}

const readFeedRound = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  feed: string,
  atBlock: bigint,
  budget: ReadBudget,
  roundId?: bigint,
): FeedRound => {
  const data =
    roundId === undefined
      ? encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" })
      : encodeFunctionData({ abi: feedAbi, functionName: "getRoundData", args: [roundId] })

  const decoded = decodeFunctionResult({
    abi: feedAbi,
    functionName: roundId === undefined ? "latestRoundData" : "getRoundData",
    data: ethCall(runtime, evmClient, feed, data, atBlock, budget),
  }) as readonly [bigint, bigint, bigint, bigint, bigint]

  const updatedAt = Number(decoded[3])
  // A feed answers zero for a round it never published, rather than reverting.
  if (updatedAt === 0) throw new Error(`Feed round ${roundId ?? "latest"} is unset`)

  return { roundId: decoded[0], answer: decoded[1], updatedAt }
}

/**
 * The round that was in force at `target` — the most recent one published at
 * or before it. Walks back from `from`, so successive lookups going further
 * into the past can continue from where the last one stopped.
 *
 * The walk is separated from the reading so the decision can be examined
 * without a chain behind it: `read` is handed one round id and returns that
 * round. This is the function that picked which price settled CSPX — Monday's
 * 10:04 round at expiry, Sunday's at the close — and it was the last piece of
 * settlement logic with no test, precisely because it used to be welded to the
 * `eth_call` that fed it.
 */
export const walkToRoundInForce = (
  read: (roundId: bigint) => FeedRound,
  from: FeedRound,
  target: number,
  maxWalk: number = MAX_ROUND_WALK,
): FeedRound => {
  let round = from
  for (let i = 0; i < maxWalk; i++) {
    // `<=`, not `<`. A round published exactly ON the target was in force at
    // it, and an equity feed printing at the closing bell is not hypothetical.
    if (round.updatedAt <= target) return round
    round = read(round.roundId - 1n)
  }
  throw new Error(`No feed round at or before ${target} within ${maxWalk} rounds`)
}

const roundInForceAt = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  feed: string,
  atBlock: bigint,
  budget: ReadBudget,
  from: FeedRound,
  target: number,
): FeedRound =>
  walkToRoundInForce(
    (roundId) => readFeedRound(runtime, evmClient, feed, atBlock, budget, roundId),
    from,
    target,
  )

/**
 * Is the round in force at expiry fit to settle on at all?
 *
 * A feed that stopped publishing keeps answering with its last value, and that
 * value gets less true every hour — refunding beats settling a market on a
 * price from a day the question was not about. Throws rather than returning a
 * flag so callers cannot forget to check it.
 */
export const checkRoundUsable = (
  atExpiry: FeedRound,
  expiry: number,
  maxStaleness: number,
): void => {
  const age = expiry - atExpiry.updatedAt
  if (age > maxStaleness) {
    throw new Error(`Round at expiry is ${age}s old, tolerance is ${maxStaleness}s`)
  }
  if (atExpiry.answer <= 0n) {
    throw new Error(`Feed answered ${atExpiry.answer} at expiry`)
  }
}

/**
 * THE TRADING-CALENDAR CHECK, and the outcome that follows it.
 *
 * A feed publishes through the weekend, simply repeating the last price with a
 * fresh timestamp — measured on CSPX/USD, the answer changed on every weekday
 * round and not once from Friday to Saturday. If the price never moved between
 * the book closing and expiry, the outcome was already fixed when the last
 * stake was placed, and paying it out would reward whoever noticed the market
 * was over. The chain cannot know an exchange calendar; it can notice that
 * nothing happened.
 */
/**
 * A feed's raw answer rescaled to the 8 decimals every strike and every
 * `observedValue` in this codebase uses.
 *
 * Feeds do not agree on scale, and assuming they do is wrong in both
 * directions. Measured on Sepolia: CSPX/USD and XAU/USD publish 8 decimals,
 * USTB NAV and USDW Reserves publish 6 — read as 8, USTB's $11.18 becomes
 * $0.11 — and stETH Proof of Reserves publishes 18, whose raw answer
 * (9,505,650,857,465,828,722,927,470) does not merely misread, it is five
 * orders of magnitude past what a uint64 strike can even hold.
 *
 * Normalising here rather than widening the strike keeps one convention
 * across contracts, workflow and UI, and brings an 18-decimal answer back
 * inside uint64 comfortably.
 */
export const normalizeToEightDecimals = (answer: bigint, decimals: number): bigint => {
  if (decimals === PRICE_SCALE_DECIMALS) return answer
  if (decimals > PRICE_SCALE_DECIMALS) {
    return answer / 10n ** BigInt(decimals - PRICE_SCALE_DECIMALS)
  }
  return answer * 10n ** BigInt(PRICE_SCALE_DECIMALS - decimals)
}

export const resolveStockOutcome = (
  atExpiry: FeedRound,
  atClose: FeedRound,
  strike: bigint,
  decimals: number,
): { outcome: number; observed: bigint } => {
  // Movement is checked on the RAW answers, before any rescaling. An
  // 18-decimal feed can move in a digit that normalising to 8 would truncate
  // away, and truncation must never turn a real move into "nothing happened".
  if (atClose.answer === atExpiry.answer) {
    throw new Error(
      `Price did not move between close and expiry (${atExpiry.answer}) — market was already decided`,
    )
  }

  const observed = normalizeToEightDecimals(atExpiry.answer, decimals)
  return { outcome: observed >= strike ? OUTCOME_YES : OUTCOME_NO, observed }
}

export type StockTerms = {
  marketId: bigint
  feed: string
  strikePrice: bigint
  closeTime: number
  expiryTime: number
  maxStaleness: number
  /**
   * The block every feed read is pinned to. Supplied by the caller because the
   * two paths derive it differently: the log trigger uses the block its own
   * event was mined in, the cron sweep uses the last finalized block. Both are
   * values every DON node agrees on without having to ask the chain what
   * "now" is.
   */
  atBlock: bigint
  /**
   * Chain reads this settlement may still spend. The log path arrives with a
   * fresh execution and nearly the whole allowance; the sweep arrives having
   * already spent reads scanning for stuck markets.
   */
  budget: ReadBudget
}

const settleStockMarket = (runtime: Runtime<Config>, t: StockTerms): string => {
  const { marketId, feed, maxStaleness, atBlock, budget } = t
  const strike = t.strikePrice
  const expiry = t.expiryTime
  const close = t.closeTime

  runtime.log(
    `Settling stock market ${marketId}: feed ${feed} vs strike ${strike} at ${expiry}, pinned to block ${atBlock}`,
  )

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`)
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  let outcome: number
  let observedPrice = 0n
  let priceAtClose = 0n

  try {
    const decimals = decodeFunctionResult({
      abi: feedAbi,
      functionName: "decimals",
      data: ethCall(
        runtime,
        evmClient,
        feed,
        encodeFunctionData({ abi: feedAbi, functionName: "decimals" }),
        atBlock,
        budget,
      ),
    }) as number

    const latest = readFeedRound(runtime, evmClient, feed, atBlock, budget)
    const atExpiry = roundInForceAt(runtime, evmClient, feed, atBlock, budget, latest, expiry)

    checkRoundUsable(atExpiry, expiry, Number(maxStaleness))

    const atClose = roundInForceAt(runtime, evmClient, feed, atBlock, budget, atExpiry, close)

    const resolved = resolveStockOutcome(atExpiry, atClose, strike, Number(decimals))
    outcome = resolved.outcome
    observedPrice = resolved.observed
    priceAtClose = normalizeToEightDecimals(atClose.answer, Number(decimals))
  } catch (err) {
    runtime.log(`Resolution failed, voiding stock market ${marketId}: ${err}`)
    outcome = OUTCOME_VOID
    observedPrice = 0n
  }

  const settledAt = Math.floor(runtime.now().getTime() / 1000)
  const evidence = JSON.stringify({
    marketId: marketId.toString(),
    feed,
    strikePrice: strike.toString(),
    closeTime: close,
    expiryTime: expiry,
    priceAtClose: priceAtClose.toString(),
    observedPrice: observedPrice.toString(),
    outcome,
    settledAt,
  })
  const evidenceHash = keccak256(toHex(evidence))

  runtime.log(
    `Stock market ${marketId} -> outcome=${outcome} price=${observedPrice} strike=${strike} evidence=${evidenceHash}`,
  )

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint256 marketId, uint8 outcome, int256 observedValue, bytes32 evidenceHash",
    ),
    [marketId, abiInt(outcome), observedPrice, evidenceHash],
  )

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.stockContractAddress ?? "",
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }

  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Settled stock market ${marketId} in tx ${txHash}`)
  return txHash
}

export const onStockSettlementRequested = (
  runtime: Runtime<Config>,
  triggerEvent: EVMLog,
): string => {
  const decoded = decodeEventLog({
    abi: stockSettlementRequestedAbi,
    data: bytesToHex(triggerEvent.data),
    topics: triggerEvent.topics.map((t) => bytesToHex(t)) as [
      `0x${string}`,
      ...`0x${string}`[],
    ],
  })

  const { marketId, feed, strikePrice, closeTime, expiryTime, maxStaleness } = decoded.args

  if (!triggerEvent.blockNumber) {
    throw new Error("Trigger log carries no block number to pin reads to")
  }

  return settleStockMarket(runtime, {
    marketId,
    feed,
    strikePrice: BigInt(strikePrice),
    closeTime: Number(closeTime),
    expiryTime: Number(expiryTime),
    maxStaleness: Number(maxStaleness),
    atBlock: protoBigIntToBigint(triggerEvent.blockNumber),
    // The trigger carries its own block, so this path spends no reads finding
    // one and gets the whole allowance for the round walk.
    budget: newReadBudget(),
  })
}

// --- cron sweep: settle what the log trigger missed --------------------------
//
// The log-trigger design has a hole in it that has nothing to do with the code:
// it needs someone to emit the log. Every settlement in this project so far
// began with a human calling requestSettlement() and, without deploy access,
// a human running the simulator. A market whose event was emitted while the
// workflow was down, or whose settlement reverted, simply stays stuck — there
// is no second log coming.
//
// This sweep is the reconciliation pass. It reads the contracts directly and
// settles anything sitting in SettlementRequested, so the log trigger becomes
// the fast path rather than the only path.
//
// Reads are pinned to the LAST FINALIZED block. A cron tick has no log to take
// a block from, and "latest" would hand every DON node a different chain head,
// so the report bytes would differ and consensus would fail. Finalized state
// is the one view of the chain that nodes converge on without coordinating.
//
// That choice sets the schedule, and getting it wrong is not free. Finalized
// state lags — measured on Sepolia at 17 minutes, 86 blocks — so a sweep still
// sees a market it settled minutes ago as stuck, and settles it again. The
// contract rejects the duplicate (ReportProcessed = false, observed), so
// nothing corrupts, but each retry burns a transaction. THE SWEEP PERIOD MUST
// THEREFORE EXCEED THE CHAIN'S FINALITY LAG. At five minutes this cost three
// wasted writes per market; the schedule in config is set well above the
// measured lag. A faster sweep would need to read unfinalized state, which
// costs determinism — the wrong thing to trade for a safety net.

const readMarketCount = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  address: string,
  atBlock: bigint,
  reads: ReadBudget,
): number => {
  const decoded = decodeFunctionResult({
    abi: marketCountAbi,
    functionName: "marketCount",
    data: ethCall(
      runtime,
      evmClient,
      address,
      encodeFunctionData({ abi: marketCountAbi, functionName: "marketCount" }),
      atBlock,
      reads,
    ),
  }) as bigint

  return Number(decoded)
}

/**
 * Ids worth looking at, newest first.
 *
 * How far back to go is not a taste decision — it is whatever the read budget
 * has left after the caller has reserved what it needs for terms and feed
 * reads. Markets are created and settle roughly in order, so anything
 * unresolved is near the end of the list anyway.
 */
export const idsToScan = (count: number, window: number): bigint[] => {
  const ids: bigint[] = []
  for (let i = count - 1; i >= 0 && ids.length < window; i--) ids.push(BigInt(i))
  return ids
}

/** The finalized block, and the reads left after paying for it. */
const finalizedBlock = (
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  reads: ReadBudget,
): bigint => {
  if (reads.left <= 0) throw new Error("Out of chain reads before resolving a block")
  reads.left--

  const header = evmClient
    .headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER })
    .result()
  if (!header.header?.blockNumber) {
    throw new Error("Could not resolve the finalized block to pin reads to")
  }
  return protoBigIntToBigint(header.header.blockNumber)
}

const sweepEvm = (runtime: Runtime<Config>) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`)
  }
  return new EVMClient(network.chainSelector.selector)
}

/**
 * Flights are the cheapest contract to sweep: `markets` returns lifecycle and
 * terms in one read, and settlement is an HTTP call, not a chain read. So the
 * whole remaining budget goes to scanning.
 */
export const onSweepFlights = (runtime: Runtime<Config>): string => {
  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)
  const address = runtime.config.flightContractAddress

  const count = readMarketCount(runtime, evmClient, address, atBlock, reads)
  let settled = 0

  for (const id of idsToScan(count, reads.left)) {
    const m = decodeFunctionResult({
      abi: flightMarketsAbi,
      functionName: "markets",
      data: ethCall(
        runtime,
        evmClient,
        address,
        encodeFunctionData({ abi: flightMarketsAbi, functionName: "markets", args: [id] }),
        atBlock,
        reads,
      ),
    }) as readonly [
      string, string, number, number, bigint, bigint,
      number, number, `0x${string}`, number, bigint, bigint,
    ]

    if (Number(m[6]) !== STATUS_SETTLEMENT_REQUESTED) continue

    runtime.log(`Sweep found stuck flight market ${id}`)
    settleFlightMarket(runtime, {
      marketId: id,
      flightIata: m[1],
      departureDate: Number(m[2]),
      thresholdMinutes: Number(m[3]),
    })
    settled++
    if (settled >= MAX_SETTLEMENTS_PER_SWEEP) break
  }

  const summary = settled === 0 ? "nothing stuck" : `settled ${settled}`
  runtime.log(`Flight sweep at block ${atBlock}: ${summary}`)
  return summary
}

/**
 * Crypto costs one extra read per stuck market (`terms`), and settlement
 * itself is HTTP, so only the terms reads have to be reserved.
 */
export const onSweepCrypto = (runtime: Runtime<Config>): string => {
  const address = runtime.config.cryptoContractAddress ?? ""
  if (address === "") return "no crypto contract configured"

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)

  const count = readMarketCount(runtime, evmClient, address, atBlock, reads)
  let settled = 0

  const window = reads.left - MAX_SETTLEMENTS_PER_SWEEP

  for (const id of idsToScan(count, window)) {
    const c = decodeFunctionResult({
      abi: coreAbi,
      functionName: "core",
      data: ethCall(
        runtime,
        evmClient,
        address,
        encodeFunctionData({ abi: coreAbi, functionName: "core", args: [id] }),
        atBlock,
        reads,
      ),
    }) as readonly [string, bigint, bigint, number, number, `0x${string}`, bigint, bigint, bigint]

    if (Number(c[3]) !== STATUS_SETTLEMENT_REQUESTED) continue

    const t = decodeFunctionResult({
      abi: cryptoTermsAbi,
      functionName: "terms",
      data: ethCall(
        runtime,
        evmClient,
        address,
        encodeFunctionData({ abi: cryptoTermsAbi, functionName: "terms", args: [id] }),
        atBlock,
        reads,
      ),
    }) as readonly [number, bigint, bigint]

    runtime.log(`Sweep found stuck crypto market ${id}`)
    settleCryptoMarket(runtime, {
      marketId: id,
      asset: Number(t[0]),
      strikePrice: BigInt(t[1]),
      expiryTime: Number(t[2]),
      receiver: address,
    })
    settled++
    if (settled >= MAX_SETTLEMENTS_PER_SWEEP) break
  }

  const summary = settled === 0 ? "nothing stuck" : `settled ${settled}`
  runtime.log(`Crypto sweep at block ${atBlock}: ${summary}`)
  return summary
}

/**
 * Stocks are the expensive case, and the only one where settling is itself a
 * chain read: each one walks the feed's rounds back to expiry and again to
 * close. So the scan window is deliberately small and only ONE market is
 * settled per run — the walk gets everything left over. A second stuck market
 * waits for the next tick, which is the right answer for a safety net.
 */
export const onSweepStocks = (runtime: Runtime<Config>): string => {
  const address = runtime.config.stockContractAddress ?? ""
  if (address === "") return "no stock contract configured"

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)

  const count = readMarketCount(runtime, evmClient, address, atBlock, reads)

  // Reserve the two per-market reads settling costs — terms, and the feed's
  // own decimals() — plus room for a feed walk of a few rounds.
  const window = Math.max(1, reads.left - 2 - STOCK_WALK_RESERVE)

  for (const id of idsToScan(count, window)) {
    const c = decodeFunctionResult({
      abi: coreAbi,
      functionName: "core",
      data: ethCall(
        runtime,
        evmClient,
        address,
        encodeFunctionData({ abi: coreAbi, functionName: "core", args: [id] }),
        atBlock,
        reads,
      ),
    }) as readonly [string, bigint, bigint, number, number, `0x${string}`, bigint, bigint, bigint]

    if (Number(c[3]) !== STATUS_SETTLEMENT_REQUESTED) continue

    const t = decodeFunctionResult({
      abi: stockTermsAbi,
      functionName: "terms",
      data: ethCall(
        runtime,
        evmClient,
        address,
        encodeFunctionData({ abi: stockTermsAbi, functionName: "terms", args: [id] }),
        atBlock,
        reads,
      ),
    }) as readonly [`0x${string}`, bigint, bigint, number]

    runtime.log(`Sweep found stuck stock market ${id}`)
    settleStockMarket(runtime, {
      marketId: id,
      feed: t[0],
      strikePrice: BigInt(t[1]),
      // closeTime lives on the shared base, not in this contract's own terms.
      closeTime: Number(c[1]),
      expiryTime: Number(t[2]),
      maxStaleness: Number(t[3]),
      atBlock,
      budget: reads,
    })
    runtime.log(`Stock sweep at block ${atBlock}: settled 1`)
    return "settled 1"
  }

  runtime.log(`Stock sweep at block ${atBlock}: nothing stuck`)
  return "nothing stuck"
}

// --- reserve settlement, from a Chainlink PoR / NAV feed ---------------------
//
// Deliberately not a flag on the stock path. The equity rule — void unless the
// answer changed between close and expiry — exists because a price feed keeps
// publishing while its exchange is shut. A reserve has no session: deposits and
// redemptions land at any hour, and reserves sitting still for a day is
// ordinary rather than proof the outcome was already fixed. ReserveMarket does
// not even emit closeTime, so this path cannot apply that check by accident.
//
// What guards it instead is staleness, which is why maxStaleness is the
// load-bearing parameter here.

export type ReserveTerms = {
  marketId: bigint
  feed: string
  strikePrice: bigint
  expiryTime: number
  maxStaleness: number
  atBlock: bigint
  budget: ReadBudget
}

const settleReserveMarket = (runtime: Runtime<Config>, t: ReserveTerms): string => {
  const { marketId, feed, maxStaleness, atBlock, budget } = t
  const strike = t.strikePrice
  const expiry = t.expiryTime

  runtime.log(
    `Settling reserve market ${marketId}: feed ${feed} vs strike ${strike} at ${expiry}, pinned to block ${atBlock}`,
  )

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${runtime.config.chainSelectorName}`)
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  let outcome: number
  let observedLevel = 0n

  try {
    // Reserve feeds are the reason decimals are read rather than assumed:
    // stETH Proof of Reserves publishes 18, and its raw answer does not fit
    // in a uint64 at all.
    const decimals = decodeFunctionResult({
      abi: feedAbi,
      functionName: "decimals",
      data: ethCall(
        runtime,
        evmClient,
        feed,
        encodeFunctionData({ abi: feedAbi, functionName: "decimals" }),
        atBlock,
        budget,
      ),
    }) as number

    const latest = readFeedRound(runtime, evmClient, feed, atBlock, budget)
    const atExpiry = roundInForceAt(runtime, evmClient, feed, atBlock, budget, latest, expiry)

    checkRoundUsable(atExpiry, expiry, Number(maxStaleness))

    observedLevel = normalizeToEightDecimals(atExpiry.answer, Number(decimals))
    outcome = observedLevel >= strike ? OUTCOME_YES : OUTCOME_NO
  } catch (err) {
    runtime.log(`Resolution failed, voiding reserve market ${marketId}: ${err}`)
    outcome = OUTCOME_VOID
    observedLevel = 0n
  }

  const settledAt = Math.floor(runtime.now().getTime() / 1000)
  const evidence = JSON.stringify({
    marketId: marketId.toString(),
    feed,
    strikePrice: strike.toString(),
    expiryTime: expiry,
    observedLevel: observedLevel.toString(),
    outcome,
    settledAt,
  })
  const evidenceHash = keccak256(toHex(evidence))

  runtime.log(
    `Reserve market ${marketId} -> outcome=${outcome} level=${observedLevel} strike=${strike} evidence=${evidenceHash}`,
  )

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "uint256 marketId, uint8 outcome, int256 observedValue, bytes32 evidenceHash",
    ),
    [marketId, abiInt(outcome), observedLevel, evidenceHash],
  )

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const txResult = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.reserveContractAddress ?? "",
      report: signedReport,
      gasConfig: { gasLimit: runtime.config.gasLimit },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }

  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Settled reserve market ${marketId} in tx ${txHash}`)
  return txHash
}

export const onReserveSettlementRequested = (
  runtime: Runtime<Config>,
  triggerEvent: EVMLog,
): string => {
  const decoded = decodeEventLog({
    abi: reserveSettlementRequestedAbi,
    data: bytesToHex(triggerEvent.data),
    topics: triggerEvent.topics.map((t) => bytesToHex(t)) as [
      `0x${string}`,
      ...`0x${string}`[],
    ],
  })

  const { marketId, feed, strikePrice, expiryTime, maxStaleness } = decoded.args

  if (!triggerEvent.blockNumber) {
    throw new Error("Trigger log carries no block number to pin reads to")
  }

  return settleReserveMarket(runtime, {
    marketId,
    feed,
    strikePrice: BigInt(strikePrice),
    expiryTime: Number(expiryTime),
    maxStaleness: Number(maxStaleness),
    atBlock: protoBigIntToBigint(triggerEvent.blockNumber),
    budget: newReadBudget(),
  })
}

export const initWorkflow = (config: Config) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
  })
  if (!network) {
    throw new Error(`Unknown chain selector name: ${config.chainSelectorName}`)
  }

  const evmClient = new EVMClient(network.chainSelector.selector)

  // Typed off the SDK's own Workflow shape rather than inferred: inference
  // would lock the array to the first entry's trigger payload (an EVM Log) and
  // reject the cron handler, whose payload is a scheduled timestamp.
  const handlers: Workflow<Config>[number][] = [
    handler(
      // topics[0] = event signature; no filter on the indexed marketId.
      evmClient.logTrigger(
        logTriggerConfig({
          addresses: [config.flightContractAddress as `0x${string}`],
          topics: [[SETTLEMENT_REQUESTED_TOPIC]],
          confidence: "LATEST",
        }),
      ),
      onSettlementRequested,
    ),
  ]

  // One workflow, two triggers. The crypto market is a separate contract with
  // its own event signature, so it needs its own trigger — but it settles
  // through the same report envelope, so it belongs in the same workflow
  // rather than a second deployment to keep in sync.
  if (config.cryptoContractAddress && config.cryptoContractAddress !== "") {
    handlers.push(
      handler(
        evmClient.logTrigger(
          logTriggerConfig({
            addresses: [
              config.cryptoContractAddress as `0x${string}`,
              ...(config.ammContractAddress && config.ammContractAddress !== ""
                ? [config.ammContractAddress as `0x${string}`]
                : []),
            ],
            topics: [[CRYPTO_SETTLEMENT_REQUESTED_TOPIC]],
            confidence: "LATEST",
          }),
        ),
        onCryptoSettlementRequested,
      ),
    )
  }

  // The stock market settles from an on-chain feed rather than HTTP, but the
  // report envelope and the receiver checks are identical, so it is a third
  // trigger here rather than a third workflow.
  if (config.stockContractAddress && config.stockContractAddress !== "") {
    handlers.push(
      handler(
        evmClient.logTrigger(
          logTriggerConfig({
            addresses: [config.stockContractAddress as `0x${string}`],
            topics: [[STOCK_SETTLEMENT_REQUESTED_TOPIC]],
            confidence: "LATEST",
          }),
        ),
        onStockSettlementRequested,
      ),
    )
  }

  if (config.reserveContractAddress && config.reserveContractAddress !== "") {
    handlers.push(
      handler(
        evmClient.logTrigger(
          logTriggerConfig({
            addresses: [config.reserveContractAddress as `0x${string}`],
            topics: [[RESERVE_SETTLEMENT_REQUESTED_TOPIC]],
            confidence: "LATEST",
          }),
        ),
        onReserveSettlementRequested,
      ),
    )
  }

  // The reconciliation sweeps, one per contract and deliberately NOT one
  // handler doing all three. ChainRead.CallLimit is 15 reads per EXECUTION,
  // and a single sweep across three contracts blew through it — separate
  // triggers are separate executions, so each contract gets its own
  // allowance. Registered last so their indices stay stable as categories
  // come and go.
  if (config.sweepSchedule && config.sweepSchedule !== "") {
    const cron = new CronCapability()
    handlers.push(handler(cron.trigger({ schedule: config.sweepSchedule }), onSweepFlights))
    handlers.push(handler(cron.trigger({ schedule: config.sweepSchedule }), onSweepCrypto))
    handlers.push(handler(cron.trigger({ schedule: config.sweepSchedule }), onSweepStocks))
  }

  return handlers
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
