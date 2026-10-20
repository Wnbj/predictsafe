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
  /**
   * AssetExchange address — the synthetic gold / S&P 500 market. Empty, or
   * the zero address, leaves the order filler unregistered.
   */
  exchangeContractAddress?: string
  /**
   * Cron schedule for filling exchange orders, six-field form. Separate from
   * `sweepSchedule` because it answers a different clock: a settlement sweep
   * catches what the log trigger missed, while this is the ONLY thing that
   * fills orders automatically, so it runs more often.
   */
  exchangeSchedule?: string
  /**
   * SettlementKeeper address. Empty, or the zero address, leaves the
   * automatic settlement requester unregistered — markets then wait for
   * someone to press "Request settlement", as they did before it existed.
   */
  keeperContractAddress?: string
  /** Cron schedule for asking the keeper what is due, six-field form. */
  keeperSchedule?: string
  /**
   * MarketScheduler address. Empty, or the zero address, leaves the market
   * opener unregistered — markets are then opened only by people.
   */
  schedulerContractAddress?: string
  /** Cron schedule for opening scheduled markets, six-field form. */
  schedulerSchedule?: string
  /** Which markets to keep open — see `candidateFor`. */
  marketSchedules?: MarketScheduleRule[]
  /**
   * Chainlink Data Feeds the strikes are taken from, by symbol (BTC, XAU,
   * USTB, …). A bare address means 8 decimals.
   */
  priceFeeds?: Record<string, string | { address: string; decimals: number }>
  /** SportsMarket address. Empty, or the zero address, leaves sports off. */
  sportsContractAddress?: string
  /** Cron schedule for the sports cycle — settle what finished, open what is next. */
  sportsSchedule?: string
  /** football-data.org v4, e.g. https://api.football-data.org/v4 */
  footballApiUrl?: string
  /** Vault secret id holding the football-data.org key. */
  footballApiKeySecretId?: string
  /** Competition codes to open matches from: PL, CL, PD … */
  sportsCompetitions?: string[]
  /** At most this many matches open (unsettled) at once. */
  sportsMaxOpenMatches?: number
  /** Liquidity per market, whole mUSDC. */
  sportsLiquidity?: number
  /** Opening chance of home, draw, away, in basis points. */
  sportsOpeningBps?: [number, number, number]
  sportsFeeBps?: number
  gasLimit: string
}

export type ScheduledAsset = "BTC" | "ETH"
export type ScheduledKind = "crypto" | "stock" | "reserve" | "flight" | "amm"

/**
 * One kind of market to keep open. `kind` defaults to crypto, the only kind
 * the first scheduler had.
 */
export interface MarketScheduleRule {
  kind?: ScheduledKind
  /** crypto, amm: the asset; also the feed the strike comes from. */
  asset?: ScheduledAsset
  /** stock, reserve: the symbol registered on the contract, and its feed. */
  symbol?: string
  /** stock, reserve: what the question calls it — "gold (XAU)". */
  label?: string
  /** stock, reserve: "$" for a price, "" for a count of tokens. */
  unit?: string
  /** Slot length: a market expires at every multiple of this, in UTC… */
  horizonSeconds?: number
  /** …shifted by this — 72000 puts a daily slot at 20:00 UTC. */
  offsetSeconds?: number
  /** Staking closes this long before expiry. */
  closeBeforeSeconds?: number
  /** Only expiries on Monday to Friday, UTC: an exchange-hours feed. */
  weekdaysOnly?: boolean
  /** Strikes round to this, in the feed's units. Defaults per asset. */
  strikeStep?: number
  /**
   * Added to the current value BEFORE rounding — the drift expected by
   * expiry. A fund NAV only climbs, about $0.0011 a day for USTB (measured
   * over 14 rounds to 2026-10-20), so a strike AT today's value is a market
   * that is already decided; at today's value plus the expected accrual it is
   * a real question about whether the yield holds.
   */
  strikeOffset?: number
  /** stock, reserve: how old the round at expiry may be. */
  maxStalenessSeconds?: number
  /** flight: flight number and delay threshold, for the flight `daysAhead`. */
  flight?: string
  thresholdMinutes?: number
  daysAhead?: number
  /** amm: opening liquidity in whole mUSDC, and the pool fee. */
  liquidity?: number
  feeBps?: number
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

/**
 * Spreading ten nodes over a rate limit that only tolerates one.
 *
 * A DON is ten nodes and every one of them makes the HTTP call — that is what
 * consensus over an off-chain read means. Measured 2026-09-20 against the free
 * RapidAPI tier: ONE node got an answer and nine got HTTP 429, all in the same
 * second, and the settlement voided because nine errors is >= f+1.
 *
 * The shape of that failure is the reason this exists rather than a bigger
 * plan. An exhausted monthly quota would have failed all ten; one success says
 * the key is valid and in budget, and the limit is about SIMULTANEITY. Ten
 * calls that arrive together are the problem, so arriving apart is the fix.
 *
 * Full jitter over a doubling window, not a fixed backoff: a fixed one moves
 * the collision rather than dissolving it, because ten nodes that failed
 * together would retry together. The FIRST attempt is jittered too — t=0 is
 * precisely the moment every node is guaranteed to be present.
 *
 * CONSENSUS SAFETY: this varies WHEN a node calls, never what it answers.
 * Nothing here reaches `Observation`, which is the thing aggregated across
 * nodes — see the hazard note on that type. Node mode exists for exactly this
 * kind of per-node divergence.
 */
const FIRST_WINDOW_MS = 1_500
const FETCH_ATTEMPTS = 3
const TOO_MANY_REQUESTS = 429

/**
 * How long this node waits before its `attempt`-th try.
 *
 * Pure, and separated from the sleeping so the spread can be examined without
 * a host behind it: `randomSeed` and `sleep` are QuickJS globals that do not
 * exist under `bun test`.
 *
 * The seed's range is deliberately not assumed. A value already in [0,1) is
 * used as is; anything larger is reduced modulo a prime. Both paths land in
 * [0,1), which is all the caller needs, and neither depends on where the
 * number came from.
 */
export const retryDelayMs = (
  attempt: number,
  seed: number,
  firstWindowMs: number = FIRST_WINDOW_MS,
): number => {
  const magnitude = Math.abs(seed)
  const unit = !Number.isFinite(magnitude)
    ? 0.5
    : magnitude < 1
      ? magnitude
      : (magnitude % 1_000_003) / 1_000_003
  return Math.floor(unit * firstWindowMs * 2 ** attempt)
}

/**
 * One HTTP read, retried while the provider is saying "too many".
 *
 * Only 429 is retried. Every other failure — a 404, a 500, a malformed body —
 * is answered on the first try and retrying it would just spend the budget
 * that the nodes being rate-limited need.
 *
 * There is no `runtime` here to log with: this runs inside the node-mode
 * function, which receives a sender and nothing else. So the waiting is
 * carried in the ERROR instead, and the consensus failure prints every node's
 * message — which is the only place it can be read anyway.
 */
/**
 * Per-node entropy, from two sources because neither is guaranteed on its own.
 *
 * The SDK's types declare a `randomSeed(1)` global for exactly this, and it
 * DOES NOT EXIST at runtime — measured 2026-09-21 in the simulator, which
 * throws `randomSeed is not defined`. It is a host binding for the SDK itself,
 * not part of the workflow sandbox. A typecheck passes on it, so this is one
 * more entry in the list of places where the installed types describe more
 * than the runtime provides.
 *
 * What the same probe found present: `sleep`, `Math.random` and `Date.now`.
 * Absent: `crypto` and `performance`.
 *
 * Both are mixed because a single node cannot reveal whether either varies
 * ACROSS nodes, and each could plausibly be pinned: QuickJS may be seeded
 * deterministically for reproducibility, and a host clock may be fixed for
 * consensus. If either one varies, the nodes separate — and the error message
 * carries the total wait, so the DON's own logs will say which.
 */
const jitterSeed = (): number => Math.random() * 1_000_003 + (Date.now() % 100_000)

const sendSpreadOverNodes = <T>(
  send: () => T,
  statusOf: (r: T) => number,
  label: string,
  firstWindowMs: number = FIRST_WINDOW_MS,
): T => {
  let waited = 0
  let last = 0
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const delay = retryDelayMs(attempt, jitterSeed(), firstWindowMs)
    waited += delay
    sleep(delay)

    const response = send()
    last = statusOf(response)
    if (last !== TOO_MANY_REQUESTS) return response
  }
  throw new Error(
    `HTTP ${last} for ${label} after ${FETCH_ATTEMPTS} attempts over ${waited}ms`,
  )
}

const readAeroDataBox = (
  sendRequester: HTTPSendRequester,
  apiUrl: string,
  apiKey: string,
  flightIata: string,
  departureDateIso: string,
): SourceReading => {
  const url = `${apiUrl}/flights/number/${flightIata}/${departureDateIso}?dateLocalRole=Departure`
  const response = sendSpreadOverNodes(
    () =>
      sendRequester
        .sendRequest({
          url,
          method: "GET",
          headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
          },
        })
        .result(),
    (r) => r.statusCode,
    flightIata,
  )

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

// --- the asset exchange ---------------------------------------------------

/**
 * AssetExchange sells synthetic gold and S&P 500 tokens priced by Chainlink
 * Data Feeds, and every order fills at the first NEW price published after it.
 *
 * This handler is the keeper, and deliberately nothing more. It asks the
 * contract which orders have a new price to fill at and sends back their ids.
 * The report carries no price and no round: the contract finds both itself,
 * from the feed, and `fill` is open to anyone with the same result. So a
 * wrong, late or missing report can delay a fill, and cannot change one.
 *
 * Reads are pinned to the last finalized block, like the other sweeps, so all
 * ten nodes see the same list. The contract recomputes at execution time, so
 * an order someone filled by hand in the meantime is simply skipped.
 */
const exchangeAbi = [
  {
    type: "function",
    name: "fillableOrders",
    stateMutability: "view",
    inputs: [{ name: "max", type: "uint256" }],
    outputs: [{ name: "ids", type: "uint256[]" }],
  },
] as const

/**
 * Orders per fill report. Each fill walks the feed from its order's round to
 * the first new price — about one round on a weekday, but around 46 after a
 * weekend of hourly gold heartbeats — so a report is kept small enough that
 * the worst case stays well inside its gas.
 */
export const EXCHANGE_FILLS_PER_REPORT = 2

/** Gas for one fill report; see EXCHANGE_FILLS_PER_REPORT for the sizing. */
const EXCHANGE_GAS_LIMIT = "6000000"

/** The report `AssetExchange._processReport` decodes: `abi.encode(uint256[])`. */
export const encodeFillReport = (ids: readonly bigint[]): `0x${string}` =>
  encodeAbiParameters(parseAbiParameters("uint256[] orderIds"), [ids])

export const onFillOrders = (runtime: Runtime<Config>): string => {
  const address = runtime.config.exchangeContractAddress ?? ""
  if (address === "" || address === ZERO_ADDRESS) return "no exchange configured"

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)

  const ids = decodeFunctionResult({
    abi: exchangeAbi,
    functionName: "fillableOrders",
    data: ethCall(
      runtime,
      evmClient,
      address,
      encodeFunctionData({
        abi: exchangeAbi,
        functionName: "fillableOrders",
        args: [BigInt(EXCHANGE_FILLS_PER_REPORT)],
      }),
      atBlock,
      reads,
    ),
  }) as readonly bigint[]

  if (ids.length === 0) {
    runtime.log(`Exchange at block ${atBlock}: nothing to fill`)
    return "nothing to fill"
  }

  runtime.log(`Exchange at block ${atBlock}: filling orders ${ids.join(", ")}`)
  const signedReport = runtime.report(prepareReportRequest(encodeFillReport(ids))).result()
  const txResult = evmClient
    .writeReport(runtime, {
      receiver: address,
      report: signedReport,
      gasConfig: { gasLimit: EXCHANGE_GAS_LIMIT },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Fill write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }
  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Filled orders ${ids.join(", ")} in tx ${txHash}`)
  return txHash
}

// --- automatic settlement requests -------------------------------------------

/**
 * Settlement used to need a person: the market contracts accept a report only
 * for a market in SettlementRequested, and only `requestSettlement` puts it
 * there. That call is open to anyone, but a DON report cannot make it — reports
 * go to `onReport`. SettlementKeeper is the bridge: this handler asks it which
 * markets are due, and reports their ids back; the keeper makes the public call,
 * the market emits its usual SettlementRequested, and the log handlers above
 * settle it exactly as if the button had been pressed.
 *
 * What counts as due lives in the CONTRACT, including the six-hour wait for
 * flights (a flight still airborne at settlement voids, which is precisely the
 * outcome a long delay must not get). So this handler decides nothing; it
 * relays. One chain read covers all five market contracts.
 *
 * Reads are pinned to the finalized block like every sweep, so a run can name
 * a market the previous run already requested. The keeper re-checks each id at
 * execution and skips those quietly; the cost is one wasted report, not a
 * wrong one.
 */
const keeperAbi = [
  {
    type: "function",
    name: "dueMarkets",
    stateMutability: "view",
    inputs: [{ name: "max", type: "uint256" }],
    outputs: [
      { name: "markets", type: "address[]" },
      { name: "ids", type: "uint256[]" },
    ],
  },
] as const

/** Requests per keeper report. One costs ~33k gas on Sepolia. */
export const KEEPER_REQUESTS_PER_REPORT = 5

/** Gas for one keeper report: five requests plus the keeper's own re-checks. */
const KEEPER_GAS_LIMIT = "1500000"

/** The report `SettlementKeeper._processReport` decodes. */
export const encodeKeeperReport = (
  markets: readonly `0x${string}`[],
  ids: readonly bigint[],
): `0x${string}` =>
  encodeAbiParameters(parseAbiParameters("address[] markets, uint256[] ids"), [markets, ids])

export const onRequestDue = (runtime: Runtime<Config>): string => {
  const address = runtime.config.keeperContractAddress ?? ""
  if (address === "" || address === ZERO_ADDRESS) return "no keeper configured"

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)

  const [markets, ids] = decodeFunctionResult({
    abi: keeperAbi,
    functionName: "dueMarkets",
    data: ethCall(
      runtime,
      evmClient,
      address,
      encodeFunctionData({
        abi: keeperAbi,
        functionName: "dueMarkets",
        args: [BigInt(KEEPER_REQUESTS_PER_REPORT)],
      }),
      atBlock,
      reads,
    ),
  }) as readonly [readonly `0x${string}`[], readonly bigint[]]

  if (ids.length === 0) {
    runtime.log(`Keeper at block ${atBlock}: nothing due`)
    return "nothing due"
  }

  const due = ids.map((id, i) => `${markets[i]}#${id}`).join(", ")
  runtime.log(`Keeper at block ${atBlock}: requesting settlement of ${due}`)
  const signedReport = runtime.report(prepareReportRequest(encodeKeeperReport(markets, ids))).result()
  const txResult = evmClient
    .writeReport(runtime, {
      receiver: address,
      report: signedReport,
      gasConfig: { gasLimit: KEEPER_GAS_LIMIT },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Keeper write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }
  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Requested settlement of ${due} in tx ${txHash}`)
  return txHash
}

// --- markets that open themselves --------------------------------------------

/**
 * Keeps the board from going empty, in every category. On a schedule, for each
 * rule — "a BTC market every hour", "gold every four hours on weekdays",
 * "tomorrow's BA286" — this handler works out the slot that ends next, skips
 * the ones MarketScheduler already opened (one read for all of them), takes a
 * strike from the right Chainlink Data Feed, and reports the terms. The
 * contract opens each market through the same public `newMarket` a person
 * would call, and the keeper and the log handlers settle it like any other.
 *
 * Every node must name the same markets, so time comes from `runtime.now()` —
 * DON time — and prices from the finalized block.
 */
const schedulerAbi = [
  {
    type: "function",
    name: "scheduledMany",
    stateMutability: "view",
    inputs: [{ name: "keys", type: "bytes32[]" }],
    outputs: [{ name: "open", type: "bool[]" }],
  },
] as const

/** MarketScheduler.Kind, in the contract's order. */
export const SCHEDULED_KIND_INDEX: Record<ScheduledKind, number> = {
  crypto: 0,
  stock: 1,
  reserve: 2,
  flight: 3,
  amm: 4,
}

/** CryptoMarket.Asset and AmmMarket.Asset, in the contracts' order. */
const SCHEDULED_ASSET_INDEX: Record<ScheduledAsset, number> = { BTC: 0, ETH: 1 }

/** Default strike steps, as in the app's Create market form. */
export const SCHEDULED_STRIKE_STEP: Record<ScheduledAsset, number> = { BTC: 100, ETH: 10 }

/**
 * A slot with less than this left to stake is passed over for the next one —
 * a run that fires late opens a market people can still reach. The contract
 * enforces its own, shorter, minimum.
 */
export const SCHEDULE_MIN_STAKING_SECONDS = 10 * 60

/** The contract refuses expiries beyond four days; stay inside that. */
const SCHEDULE_MAX_AHEAD_SECONDS = 4 * 86400 - 3600

/**
 * Markets opened per report, soonest-closing first; the rest wait for the
 * next run.
 *
 * Sepolia prices storage far above what forge's local EVM measures: one
 * `newMarket` estimated at 590k gas there against ~170k locally (2026-10-19).
 * The first run asked for four in 1.5M gas, spent 1.46M of it, and the
 * forwarder recorded the report as refused — out of gas inside the receiver.
 */
export const SCHEDULER_SPECS_PER_REPORT = 2

/**
 * 400k for the envelope, then per market: 1.1M, or 2.2M for an AMM market,
 * which also mints and moves its opening liquidity (415k locally, so ~1.45M
 * on Sepolia).
 */
export const schedulerGasLimit = (kinds: readonly ScheduledKind[]): string =>
  String(400_000 + kinds.reduce((sum, k) => sum + (k === "amm" ? 2_200_000 : 1_100_000), 0))

const isWeekday = (seconds: number): boolean => {
  const day = new Date(seconds * 1000).getUTCDay()
  return day !== 0 && day !== 6
}

/**
 * The soonest slot after `nowSeconds` that still leaves time to stake: the one
 * ending next, or — once its staking has closed, or for a weekdays-only rule
 * whose next expiry falls on a weekend — a later one. So a daily market whose
 * staking shut at 20:00 is followed by tomorrow's at the next run, rather than
 * leaving the board without one until midnight. Null when no slot within the
 * contract's horizon qualifies.
 */
export const nextSlot = (
  rule: MarketScheduleRule,
  nowSeconds: number,
): { closeTime: number; expiryTime: number } | null => {
  const h = rule.horizonSeconds ?? 3600
  const offset = rule.offsetSeconds ?? 0
  const closeBefore = rule.closeBeforeSeconds ?? 0
  let expiryTime = Math.floor((nowSeconds - offset) / h) * h + h + offset
  for (let i = 0; i < 16 && expiryTime - nowSeconds <= SCHEDULE_MAX_AHEAD_SECONDS; i++, expiryTime += h) {
    const closeTime = expiryTime - closeBefore
    if (closeTime - nowSeconds < SCHEDULE_MIN_STAKING_SECONDS) continue
    if (rule.weekdaysOnly && !isWeekday(expiryTime)) continue
    return { closeTime, expiryTime }
  }
  return null
}

/**
 * A flight `daysAhead` days out, by its UTC date: staking closes when that day
 * starts, and settlement may be asked two days later, by which time the flight
 * has landed even if it left late in the evening. The keeper adds its own six
 * hours on top.
 */
export const flightSlot = (
  rule: MarketScheduleRule,
  nowSeconds: number,
): { closeTime: number; expiryTime: number; departureDate: number } | null => {
  const day = 86400
  let start = Math.floor(nowSeconds / day) * day + (rule.daysAhead ?? 1) * day
  if (start - nowSeconds < SCHEDULE_MIN_STAKING_SECONDS) start += day
  const d = new Date(start * 1000)
  const departureDate = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  return { closeTime: start, expiryTime: start + 2 * day, departureDate }
}

/** An 8-decimal value, rounded to the nearest `step` units, still 8 decimals. */
export const roundStrike = (answer: bigint, step: number): bigint => {
  const unit = BigInt(Math.round(step * 100_000_000))
  if (unit <= 0n) return answer
  return ((answer + unit / 2n) / unit) * unit
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "83300" -> "83,300", without Intl, which the workflow runtime may not have. */
const thousands = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/**
 * An 8-decimal value as a person writes it: whole units; or cents; or, for a
 * strike finer than a cent (a fund NAV), as many places as it needs, up to four.
 */
export const formatScheduledValue = (v: bigint): string => {
  const whole = v / 100_000_000n
  const frac = (v % 100_000_000n).toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "")
  if (frac === "") return thousands(whole)
  return `${thousands(whole)}.${frac.padEnd(2, "0")}`
}

const whenUtc = (seconds: number): string => {
  const d = new Date(seconds * 1000)
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  return `${hh}:${mm} UTC on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** The same words the app's Create market form writes, in UTC. */
export const scheduledQuestion = (asset: ScheduledAsset, strike: bigint, expiryTime: number): string =>
  `Will ${asset} be at or above $${formatScheduledValue(strike)} at ${whenUtc(expiryTime)}?`

const dateLabel = (yyyymmdd: number): string =>
  `${MONTHS[Math.floor(yyyymmdd / 100) % 100 - 1]} ${yyyymmdd % 100}`

export interface ScheduledSpec {
  kind: number
  closeTime: bigint
  expiryTime: bigint
  id: string
  question: string
  terms: `0x${string}`
}

/** What one rule would open now, before knowing whether it already has. */
export interface ScheduleCandidate {
  rule: MarketScheduleRule
  kind: ScheduledKind
  id: string
  closeTime: number
  expiryTime: number
  departureDate?: number
  key: `0x${string}`
}

/** `keccak256(abi.encode(kind, closeTime, expiryTime, id))`, as MarketScheduler.slotKey. */
export const scheduledSlotKey = (kind: number, closeTime: number, expiryTime: number, id: string): `0x${string}` =>
  keccak256(
    encodeAbiParameters(parseAbiParameters("uint8, uint64, uint64, string"), [
      kind,
      BigInt(closeTime),
      BigInt(expiryTime),
      id,
    ]),
  )

/** The slot a rule names at `nowSeconds`, or null if it names none. */
export const candidateFor = (rule: MarketScheduleRule, nowSeconds: number): ScheduleCandidate | null => {
  const kind = rule.kind ?? "crypto"
  const id = kind === "flight" ? rule.flight : kind === "stock" || kind === "reserve" ? rule.symbol : rule.asset
  if (!id) return null
  const slot = kind === "flight" ? flightSlot(rule, nowSeconds) : nextSlot(rule, nowSeconds)
  if (!slot) return null
  return {
    rule,
    kind,
    id,
    ...slot,
    key: scheduledSlotKey(SCHEDULED_KIND_INDEX[kind], slot.closeTime, slot.expiryTime, id),
  }
}

/** The spec for a candidate, given its feed's price at 8 decimals (unused for flights). */
export const specFor = (c: ScheduleCandidate, price8: bigint): ScheduledSpec => {
  const r = c.rule
  const base = {
    kind: SCHEDULED_KIND_INDEX[c.kind],
    closeTime: BigInt(c.closeTime),
    expiryTime: BigInt(c.expiryTime),
    id: c.id,
  }
  if (c.kind === "flight") {
    const threshold = r.thresholdMinutes ?? 30
    return {
      ...base,
      question: `Will ${c.id} on ${dateLabel(c.departureDate ?? 0)} arrive ${threshold}m+ late?`,
      terms: encodeAbiParameters(parseAbiParameters("uint32, uint16"), [c.departureDate ?? 0, threshold]),
    }
  }
  if (c.kind === "stock" || c.kind === "reserve") {
    const offset8 = BigInt(Math.round((r.strikeOffset ?? 0) * 100_000_000))
    const strike = roundStrike(price8 + offset8, r.strikeStep ?? 1)
    const unit = r.unit ?? "$"
    return {
      ...base,
      question: `Will ${r.label ?? c.id} be at or above ${unit}${formatScheduledValue(strike)} at ${whenUtc(c.expiryTime)}?`,
      terms: encodeAbiParameters(parseAbiParameters("uint64, uint32"), [
        strike,
        r.maxStalenessSeconds ?? 2 * 86400,
      ]),
    }
  }
  const asset = c.id as ScheduledAsset
  const strike = roundStrike(price8, r.strikeStep ?? SCHEDULED_STRIKE_STEP[asset])
  const question = scheduledQuestion(asset, strike, c.expiryTime)
  if (c.kind === "amm") {
    return {
      ...base,
      question,
      terms: encodeAbiParameters(parseAbiParameters("uint8, uint64, uint256, uint256, uint16"), [
        SCHEDULED_ASSET_INDEX[asset],
        strike,
        BigInt(r.liquidity ?? 20) * 1_000_000n,
        5_000n,
        r.feeBps ?? 30,
      ]),
    }
  }
  return {
    ...base,
    question,
    terms: encodeAbiParameters(parseAbiParameters("uint8, uint64"), [SCHEDULED_ASSET_INDEX[asset], strike]),
  }
}

/** The report `MarketScheduler._processReport` decodes: `abi.encode(Spec[])`. */
export const encodeSchedulerReport = (specs: readonly ScheduledSpec[]): `0x${string}` =>
  encodeAbiParameters(
    parseAbiParameters("(uint8 kind, uint64 closeTime, uint64 expiryTime, string id, string question, bytes terms)[]"),
    [specs.map((s) => ({ ...s }))],
  )

/** A feed answer at `decimals`, rescaled to the 8 every strike uses. */
const toEight = (answer: bigint, decimals: number): bigint =>
  decimals === 8 ? answer : decimals > 8 ? answer / 10n ** BigInt(decimals - 8) : answer * 10n ** BigInt(8 - decimals)

export const onScheduleMarkets = (runtime: Runtime<Config>): string => {
  const address = runtime.config.schedulerContractAddress ?? ""
  if (address === "" || address === ZERO_ADDRESS) return "no scheduler configured"
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000)

  const candidates = (runtime.config.marketSchedules ?? []).flatMap((rule) => {
    const c = candidateFor(rule, nowSeconds)
    return c ? [c] : []
  })
  if (candidates.length === 0) return "no slot to open"

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)

  const opened = decodeFunctionResult({
    abi: schedulerAbi,
    functionName: "scheduledMany",
    data: ethCall(
      runtime,
      evmClient,
      address,
      encodeFunctionData({ abi: schedulerAbi, functionName: "scheduledMany", args: [candidates.map((c) => c.key)] }),
      atBlock,
      reads,
    ),
  }) as readonly boolean[]

  const batch = candidates
    .filter((_, i) => !opened[i])
    .sort((a, b) => a.closeTime - b.closeTime)
    .slice(0, SCHEDULER_SPECS_PER_REPORT)
  if (batch.length === 0) {
    runtime.log(`Scheduler at block ${atBlock}: every slot already open`)
    return "every slot already open"
  }

  // Only the feeds of the markets about to be opened are read.
  const prices = new Map<string, bigint>()
  const priceOf = (symbol: string): bigint => {
    const known = prices.get(symbol)
    if (known !== undefined) return known
    const entry = runtime.config.priceFeeds?.[symbol]
    const feed = typeof entry === "string" ? entry : (entry?.address ?? "")
    const decimals = typeof entry === "string" || !entry ? 8 : entry.decimals
    if (feed === "") throw new Error(`No price feed configured for ${symbol}`)
    const [, answer] = decodeFunctionResult({
      abi: feedAbi,
      functionName: "latestRoundData",
      data: ethCall(
        runtime,
        evmClient,
        feed,
        encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" }),
        atBlock,
        reads,
      ),
    }) as readonly [bigint, bigint, bigint, bigint, bigint]
    if (answer <= 0n) throw new Error(`${symbol} feed returned no price`)
    const price8 = toEight(answer, decimals)
    prices.set(symbol, price8)
    return price8
  }

  const specs = batch.map((c) => specFor(c, c.kind === "flight" ? 0n : priceOf(c.id)))

  for (const s of specs) runtime.log(`Scheduler opening: ${s.question} (closes ${s.closeTime})`)
  const signedReport = runtime.report(prepareReportRequest(encodeSchedulerReport(specs))).result()
  const txResult = evmClient
    .writeReport(runtime, {
      receiver: address,
      report: signedReport,
      gasConfig: { gasLimit: schedulerGasLimit(batch.map((c) => c.kind)) },
    })
    .result()

  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Scheduler write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }
  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Opened ${specs.length} market(s) in tx ${txHash}`)
  return txHash
}

// --- football: three AMM markets per match -------------------------------------

/**
 * One handler, once an hour, for everything football. It reads which matches
 * SportsMarket is still waiting on (one chain read), asks football-data.org
 * for the competitions' matches around today (ONE request per node), and
 * reports either results for the ones that have finished or the next match to
 * open — three markets: home win, draw, away win.
 *
 * One request per run, not one per match, because the free plan allows ten a
 * minute and every request here is made by all ten nodes. The nodes' calls
 * are spread over twenty seconds for the same reason the flight calls are.
 *
 * Consensus is on a DIGEST of the response — each match reduced to id, kickoff,
 * status, teams and the score after ninety minutes, sorted — not on the raw
 * body, whose `lastUpdated` stamps differ between nodes that asked a second
 * apart. Everything after the digest is computed from it and DON time, so
 * every node reports the same thing.
 */
const sportsAbi = [
  {
    type: "function",
    name: "unsettled",
    stateMutability: "view",
    inputs: [{ name: "max", type: "uint256" }],
    outputs: [
      { name: "ids", type: "uint64[]" },
      { name: "kickoffs", type: "uint64[]" },
    ],
  },
] as const

export const SPORTS_HOME = 1
export const SPORTS_DRAW = 2
export const SPORTS_AWAY = 3
export const SPORTS_VOID = 4

/** SportsMarket accepts a result this long after kickoff. */
const SPORTS_SETTLE_AFTER_SECONDS = 2 * 3600
/** Open a match at least this long before kickoff (the contract's floor is 30 min). */
const SPORTS_MIN_LEAD_SECONDS = 2 * 3600
/** Open matches kicking off within this horizon. */
const SPORTS_MAX_LEAD_SECONDS = 3 * 86400
/** A match missing from the feed this long after kickoff is voided rather than waited on. */
const SPORTS_GIVE_UP_SECONDS = 3 * 86400
/** Results per report; each settles three markets. */
export const SPORTS_RESULTS_PER_REPORT = 2

/**
 * Gas, from Sepolia's pricing rather than forge's. Opening a match is ~942k
 * locally — three markets, the mint, the match record — and the first real
 * one, at 18:01 UTC on 2026-10-20, spent 4,269,890 of a 4.4M limit and was
 * refused: out of gas inside the receiver, ~4.5x the local figure, more than
 * the 3.5x a crypto `newMarket` showed. 7M leaves room. A result rewrites three
 * markets' outcome, value and evidence.
 */
export const sportsGasLimit = (opens: number, results: number): string =>
  String(400_000 + opens * 7_000_000 + results * 1_500_000)

/** One match, as every node agrees on it. Goals are after ninety minutes, null until played. */
export interface FootballMatch {
  id: number
  kickoff: number
  status: string
  competition: string
  home: string
  away: string
  homeGoals: number | null
  awayGoals: number | null
}

const footballMatchSchema = z.object({
  id: z.number(),
  utcDate: z.string(),
  status: z.string(),
  competition: z.object({ code: z.string() }),
  homeTeam: z.object({ shortName: z.string().nullish(), name: z.string().nullish() }),
  awayTeam: z.object({ shortName: z.string().nullish(), name: z.string().nullish() }),
  score: z.object({
    fullTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
    regularTime: z.object({ home: z.number().nullable(), away: z.number().nullable() }).nullish(),
  }),
})
const footballResponseSchema = z.object({ matches: z.array(footballMatchSchema) })

/** Statuses football-data.org documents. */
const FOOTBALL_STATUSES = new Set([
  "SCHEDULED", "TIMED", "IN_PLAY", "LIVE", "PAUSED", "FINISHED", "POSTPONED", "SUSPENDED", "CANCELLED", "AWARDED",
])

/**
 * The response reduced to what decides a market, in a fixed order. When a
 * match went to extra time the score after ninety minutes is `regularTime`;
 * otherwise it is `fullTime`.
 *
 * A status outside the documented set is read as SCHEDULED. Measured
 * 2026-10-20: asked with `competitions=PL,CL`, the free plan answers a
 * not-yet-started match's status with a TIMESTAMP — "2026-10-21 15:45:00Z" —
 * where the same match without the filter said "TIMED". Only an explicit
 * FINISHED ever produces a result, so the worst an odd status can do is make
 * a match openable or keep it waiting.
 */
export const footballDigest = (body: unknown): string => {
  const parsed = footballResponseSchema.parse(body)
  const rows: FootballMatch[] = parsed.matches.map((m) => {
    const ninety = m.score.regularTime ?? m.score.fullTime
    return {
      id: m.id,
      kickoff: Math.floor(Date.parse(m.utcDate) / 1000),
      status: FOOTBALL_STATUSES.has(m.status) ? m.status : "SCHEDULED",
      competition: m.competition.code,
      home: (m.homeTeam.shortName ?? m.homeTeam.name ?? "").slice(0, 32),
      away: (m.awayTeam.shortName ?? m.awayTeam.name ?? "").slice(0, 32),
      homeGoals: ninety.home,
      awayGoals: ninety.away,
    }
  })
  rows.sort((a, b) => a.id - b.id)
  return JSON.stringify(rows)
}

/**
 * What to report for a match the contract is waiting on, or null to wait.
 * Postponed, cancelled, suspended or awarded matches void; a finished one
 * resolves on the score after ninety minutes; one the feed no longer lists,
 * days after kickoff, voids rather than holding money for ever.
 */
export const footballResult = (
  m: FootballMatch | undefined,
  kickoff: number,
  nowSeconds: number,
): number | null => {
  if (nowSeconds < kickoff + SPORTS_SETTLE_AFTER_SECONDS) {
    return m && ["POSTPONED", "CANCELLED"].includes(m.status) ? SPORTS_VOID : null
  }
  if (!m) return nowSeconds > kickoff + SPORTS_GIVE_UP_SECONDS ? SPORTS_VOID : null
  if (["POSTPONED", "CANCELLED", "SUSPENDED", "AWARDED"].includes(m.status)) return SPORTS_VOID
  if (m.status !== "FINISHED" || m.homeGoals === null || m.awayGoals === null) {
    return nowSeconds > kickoff + SPORTS_GIVE_UP_SECONDS ? SPORTS_VOID : null
  }
  return m.homeGoals > m.awayGoals ? SPORTS_HOME : m.homeGoals < m.awayGoals ? SPORTS_AWAY : SPORTS_DRAW
}

/** The next matches worth opening: scheduled, in the configured competitions, far enough out, soonest first. */
export const footballToOpen = (
  matches: readonly FootballMatch[],
  competitions: readonly string[],
  alreadyOpen: ReadonlySet<number>,
  nowSeconds: number,
  slots: number,
): FootballMatch[] =>
  matches
    .filter(
      (m) =>
        (m.status === "TIMED" || m.status === "SCHEDULED") &&
        competitions.includes(m.competition) &&
        !alreadyOpen.has(m.id) &&
        m.kickoff - nowSeconds >= SPORTS_MIN_LEAD_SECONDS &&
        m.kickoff - nowSeconds <= SPORTS_MAX_LEAD_SECONDS &&
        m.home !== "" &&
        m.away !== "",
    )
    .sort((a, b) => a.kickoff - b.kickoff || a.id - b.id)
    .slice(0, Math.max(0, slots))

const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10)

/** The report `SportsMarket._processReport` decodes: `abi.encode(MatchSpec[], MatchResult[])`. */
export const encodeSportsReport = (
  opens: readonly {
    matchId: bigint
    kickoff: bigint
    competition: string
    home: string
    away: string
    liquidity: bigint
    openingBps: readonly [number, number, number]
    feeBps: number
  }[],
  results: readonly { matchId: bigint; result: number; evidenceHash: `0x${string}` }[],
): `0x${string}` =>
  encodeAbiParameters(
    parseAbiParameters([
      "(uint64 matchId, uint64 kickoff, string competition, string home, string away, uint256 liquidity, uint16[3] openingBps, uint16 feeBps)[]",
      "(uint64 matchId, uint8 result, bytes32 evidenceHash)[]",
    ]),
    [opens.map((o) => ({ ...o, openingBps: [...o.openingBps] as [number, number, number] })), [...results]],
  )

const fetchFootball = (sendRequester: HTTPSendRequester, url: string, apiKey: string): { digest: string } => {
  const response = sendSpreadOverNodes(
    () => sendRequester.sendRequest({ url, method: "GET", headers: { "X-Auth-Token": apiKey } }).result(),
    (r) => r.statusCode,
    "football-data",
    20_000,
  )
  if (!ok(response)) throw new Error(`HTTP ${response.statusCode} from football-data`)
  return { digest: footballDigest(json(response)) }
}

export const onSportsCycle = (runtime: Runtime<Config>): string => {
  const address = runtime.config.sportsContractAddress ?? ""
  if (address === "" || address === ZERO_ADDRESS) return "no sports contract configured"
  const competitions = runtime.config.sportsCompetitions ?? ["PL", "CL"]
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000)

  const evmClient = sweepEvm(runtime)
  const reads = newReadBudget()
  const atBlock = finalizedBlock(runtime, evmClient, reads)
  const [ids, kickoffs] = decodeFunctionResult({
    abi: sportsAbi,
    functionName: "unsettled",
    data: ethCall(
      runtime,
      evmClient,
      address,
      encodeFunctionData({ abi: sportsAbi, functionName: "unsettled", args: [20n] }),
      atBlock,
      reads,
    ),
  }) as readonly [readonly bigint[], readonly bigint[]]

  const secretId = runtime.config.footballApiKeySecretId ?? "FOOTBALL_DATA_API_KEY"
  const apiKey = runtime
    .getSecret({ id: secretId, namespace: runtime.config.apiKeySecretNamespace ?? "main" })
    .result().value
  const apiUrl = runtime.config.footballApiUrl ?? "https://api.football-data.org/v4"
  const url = `${apiUrl}/matches?competitions=${competitions.join(",")}&dateFrom=${isoDate(nowSeconds - 3 * 86400)}&dateTo=${isoDate(nowSeconds + 3 * 86400)}`

  const { digest } = new HTTPClient()
    .sendRequest(runtime, fetchFootball, ConsensusAggregationByFields<{ digest: string }>({ digest: identical }))(
      url,
      apiKey,
    )
    .result()
  const matches = JSON.parse(digest) as FootballMatch[]
  const byId = new Map(matches.map((m) => [m.id, m]))

  // Results first: money waiting to be paid beats a new market.
  const results = ids
    .map((id, i) => {
      const m = byId.get(Number(id))
      const result = footballResult(m, Number(kickoffs[i]), nowSeconds)
      if (result === null) return null
      const evidence = m ? `${m.id}:${m.home} ${m.homeGoals ?? "-"}-${m.awayGoals ?? "-"} ${m.away}:${m.status}` : `${id}:missing`
      return { matchId: id, result, evidenceHash: keccak256(toHex(evidence)), label: evidence }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, SPORTS_RESULTS_PER_REPORT)

  // Open only when nothing is being settled this run, one match at a time:
  // a match is three markets and ~3.3M gas on Sepolia.
  const openNow = new Set(ids.map((id) => Number(id)))
  const slots = (runtime.config.sportsMaxOpenMatches ?? 3) - ids.length
  const toOpen = results.length > 0 ? [] : footballToOpen(matches, competitions, openNow, nowSeconds, Math.min(1, slots))

  if (results.length === 0 && toOpen.length === 0) {
    runtime.log(`Sports at block ${atBlock}: ${ids.length} open, nothing to settle or open`)
    return "nothing to do"
  }

  const liquidity = BigInt(runtime.config.sportsLiquidity ?? 10) * 1_000_000n
  const openingBps = runtime.config.sportsOpeningBps ?? [4_500, 2_700, 2_800]
  const opens = toOpen.map((m) => ({
    matchId: BigInt(m.id),
    kickoff: BigInt(m.kickoff),
    competition: m.competition,
    home: m.home,
    away: m.away,
    liquidity,
    openingBps,
    feeBps: runtime.config.sportsFeeBps ?? 30,
  }))
  for (const r of results) runtime.log(`Sports result: ${r.label} -> ${r.result}`)
  for (const o of toOpen) runtime.log(`Sports opening: ${o.home} v ${o.away} (${o.competition}) at ${isoDate(o.kickoff)} ${new Date(o.kickoff * 1000).toISOString().slice(11, 16)} UTC`)

  const signedReport = runtime
    .report(prepareReportRequest(encodeSportsReport(opens, results.map(({ label: _, ...r }) => r))))
    .result()
  const txResult = evmClient
    .writeReport(runtime, {
      receiver: address,
      report: signedReport,
      gasConfig: { gasLimit: sportsGasLimit(opens.length, results.length) },
    })
    .result()
  if (txResult.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Sports write failed: ${txResult.errorMessage || txResult.txStatus}`)
  }
  const txHash = bytesToHex(txResult.txHash ?? new Uint8Array(32))
  runtime.log(`Sports report in tx ${txHash}`)
  return txHash
}

/**
 * The scheduler's trigger, when football is on too: both jobs, each on its
 * own, so a football-data outage cannot stop the other categories opening and
 * a scheduler refusal cannot stop a match settling. Separate reports, separate
 * read budgets.
 */
export const onScheduleCycle = (runtime: Runtime<Config>): string => {
  const run = (name: string, job: (r: Runtime<Config>) => string): string => {
    try {
      return `${name}: ${job(runtime)}`
    } catch (err) {
      runtime.log(`${name} failed: ${err}`)
      return `${name}: failed`
    }
  }
  const results = [run("markets", onScheduleMarkets), run("sports", onSportsCycle)]
  if (results.every((r) => r.endsWith("failed"))) throw new Error(results.join("; "))
  return results.join("; ")
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

/**
 * The "this handler is switched off" address.
 *
 * The flight log handler registers unconditionally, so a config that does not
 * want it points at this instead of leaving the field empty. Named because the
 * sweeps now have to recognise it too, and a literal repeated in two places is
 * a literal that will eventually differ in one of them.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

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
  //
  // Each sweep is guarded by ITS OWN contract address, like every log handler
  // above. A sweep over an unconfigured contract is not a quiet no-op: it
  // `eth_call`s the zero address, gets `0x` back because there is no code
  // there, and throws while decoding. On a schedule that is a FAILURE
  // execution every thirty minutes, for ever, in the one list you read when
  // something is actually wrong.
  //
  // Note the asymmetry with the flight LOG handler, which registers
  // unconditionally and is silenced by pointing it at the zero address. That
  // is a handler waiting for an event nobody emits, which costs nothing. A
  // cron handler fires whether or not anything happened, so it cannot be
  // silenced the same way.
  if (config.sweepSchedule && config.sweepSchedule !== "") {
    const cron = new CronCapability()
    const sweep = (address: string | undefined, fn: (runtime: Runtime<Config>) => string) => {
      if (!address || address === "" || address === ZERO_ADDRESS) return
      handlers.push(handler(cron.trigger({ schedule: config.sweepSchedule }), fn))
    }
    sweep(config.flightContractAddress, onSweepFlights)
    sweep(config.cryptoContractAddress, onSweepCrypto)
    sweep(config.stockContractAddress, onSweepStocks)
  }

  // The exchange's order filler. Appended LAST so that every trigger index
  // before it stays where RUNBOOK's table says it is.
  const exchange = config.exchangeContractAddress ?? ""
  if (exchange !== "" && exchange !== ZERO_ADDRESS && config.exchangeSchedule) {
    handlers.push(
      handler(new CronCapability().trigger({ schedule: config.exchangeSchedule }), onFillOrders),
    )
  }

  // The automatic settlement requester, after the filler for the same reason:
  // appended, so no existing index moves.
  const keeper = config.keeperContractAddress ?? ""
  if (keeper !== "" && keeper !== ZERO_ADDRESS && config.keeperSchedule) {
    handlers.push(
      handler(new CronCapability().trigger({ schedule: config.keeperSchedule }), onRequestDue),
    )
  }

  // The market opener, appended for the same reason. Football rides on the
  // same trigger rather than its own: a workflow may subscribe to at most TEN
  // triggers ("PerWorkflow.TriggerSubscriptionLimit … cannot use 11, limit is
  // 10", from the simulator, 2026-10-20), and this list is at ten with it.
  const scheduler = config.schedulerContractAddress ?? ""
  const sports = config.sportsContractAddress ?? ""
  const hasScheduler = scheduler !== "" && scheduler !== ZERO_ADDRESS && !!config.schedulerSchedule
  const hasSports = sports !== "" && sports !== ZERO_ADDRESS
  if (hasScheduler) {
    handlers.push(
      handler(
        new CronCapability().trigger({ schedule: config.schedulerSchedule! }),
        hasSports ? onScheduleCycle : onScheduleMarkets,
      ),
    )
  } else if (hasSports && config.sportsSchedule) {
    handlers.push(handler(new CronCapability().trigger({ schedule: config.sportsSchedule }), onSportsCycle))
  }

  return handlers
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
