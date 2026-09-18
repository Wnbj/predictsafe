/** Mirrors FlightMarket.Status. */
export enum MarketStatus {
  Open = 0,
  Locked = 1,
  SettlementRequested = 2,
  Settled = 3,
  Void = 4,
}

/** Mirrors FlightMarket.Outcome. */
export enum Outcome {
  Unset = 0,
  Yes = 1,
  No = 2,
  Void = 3,
}

export type CategoryId =
  | "flights"
  | "sports"
  | "crypto"
  | "stocks"
  | "reserves"
  | "amm"
  | "pop"
  | "current";

export type Side = "yes" | "no";

/**
 * Fields every market has, whatever it is about — mirrors
 * ParimutuelMarket.Core on chain.
 */
interface MarketBase {
  /** Index within its own contract. NOT unique across contracts. */
  id: number;
  /**
   * Unique across every contract, as `"<category>:<id>"`. Market ids restart
   * at 0 in each contract, so anything identifying a market across the app —
   * React keys, event lookups, position matching — must use this, never `id`.
   */
  key: string;
  contract: `0x${string}`;
  question: string;
  closeTime: number;
  settleAfter: number;
  status: MarketStatus;
  outcome: Outcome;
  evidenceHash: `0x${string}`;
  yesPool: bigint;
  noPool: bigint;
}

export interface FlightMarket extends MarketBase {
  categoryId: "flights";
  flightIata: string;
  departureDate: number;
  thresholdMinutes: number;
  /** Minutes late, as agreed by the oracle. Negative means early. */
  observedDelay: number;
}

export interface CryptoMarket extends MarketBase {
  categoryId: "crypto";
  asset: "BTC" | "ETH";
  /** Strike and observed price both carry 8 decimals, as on chain. */
  strikePrice: bigint;
  expiryTime: number;
  observedPrice: bigint;
}

export interface StockMarket extends MarketBase {
  categoryId: "stocks";
  /** Registered feed symbol, e.g. "CSPX". */
  symbol: string;
  /** The Chainlink aggregator this market settles from. */
  feed: `0x${string}`;
  /** Strike and observed price both carry 8 decimals, as on chain. */
  strikePrice: bigint;
  expiryTime: number;
  /** How stale the round at expiry may be before the market voids, in seconds. */
  maxStaleness: number;
  observedPrice: bigint;
}

/**
 * A union rather than one wide interface with optional fields: it makes
 * reading a flight's `thresholdMinutes` off a crypto market a compile error
 * instead of a silent `undefined` rendered to the user.
 */
/**
 * Proof-of-Reserve and fund-NAV markets. Structurally the same terms as a
 * stock market, but a different contract with a different settlement rule —
 * reserves have no trading session, so they are never voided merely for
 * sitting still. Kept as its own type so the two cannot be confused.
 */
export interface ReserveMarket extends MarketBase {
  categoryId: "reserves";
  symbol: string;
  feed: `0x${string}`;
  /** Strike and observed level both carry 8 decimals, whatever the feed uses. */
  strikePrice: bigint;
  expiryTime: number;
  maxStaleness: number;
  observedPrice: bigint;
}

/**
 * A market priced by an automated market maker rather than a parimutuel pool.
 *
 * The shape differs in a way that matters: `yesReserve`/`noReserve` are SHARES
 * THE POOL HOLDS, not money staked on a side, and the price of YES is the
 * OPPOSITE reserve over the total — the scarcer YES is in the pool, the dearer
 * it is. Reading these two like parimutuel pools inverts the odds, which is
 * why `yesPriceBps` is carried explicitly and read from the contract rather
 * than derived here.
 */
export interface AmmMarket extends MarketBase {
  categoryId: "amm";
  asset: "BTC" | "ETH";
  strikePrice: bigint;
  expiryTime: number;
  /** Marginal price of YES, 0–10000. Also the price a small buy executes at. */
  yesPriceBps: number;
  yesReserve: bigint;
  noReserve: bigint;
  /** Complete sets minted — the money actually at stake in this market. */
  collateral: bigint;
  /** Whoever opened the market. Metadata: they hold no special powers. */
  creator: `0x${string}`;
  /** Denominator for every provider's claim on the pool. */
  totalLpShares: bigint;
  /** Trading fee retained by the pool, 0–500. */
  feeBps: number;
  observedPrice: bigint;
}

export type Market =
  | FlightMarket
  | CryptoMarket
  | StockMarket
  | ReserveMarket
  | AmmMarket;

/** Markets whose terms are a price against a strike, whatever the asset. */
export type PriceMarket = CryptoMarket | StockMarket | ReserveMarket | AmmMarket;

export function isPriceMarket(m: Market): m is PriceMarket {
  return (
    m.categoryId === "crypto" ||
    m.categoryId === "stocks" ||
    m.categoryId === "reserves" ||
    m.categoryId === "amm"
  );
}

/**
 * What to call the thing being priced. Crypto markets name a fixed asset from
 * an enum; stock markets name whichever feed symbol the owner registered, so
 * the label has to come from different places.
 */
export function priceAssetLabel(m: PriceMarket): string {
  return m.categoryId === "crypto" || m.categoryId === "amm" ? m.asset : m.symbol;
}

/**
 * One trade on a market, whichever pricing model it uses.
 *
 * Was `StakeEvent`, from when staking was the only way in. It has carried AMM
 * buys and sells for some time, and a name that says "stake" invites code to
 * assume the parimutuel shape — which is the specific mistake that made every
 * AMM trade invisible to the leaderboard, the activity feed and the sparkline.
 *
 * `amount` is always COLLATERAL — what left or reached the trader's wallet —
 * so anything counting money can treat every market alike. What differs is
 * what the collateral bought: a parimutuel stake buys a claim on a pot, while
 * an AMM trade buys a fixed number of shares at a price, and can be reversed
 * by selling them back. Those extras live in `amm` rather than being forced
 * into the shared fields, because a sell is a NEGATIVE position change and
 * silently folding it into `amount` would make every total wrong.
 */
export interface TradeEvent {
  /** Composite market key — see MarketBase.key. */
  marketKey: string;
  user: `0x${string}`;
  isYes: boolean;
  /** Collateral. Spent on a stake or a buy; RECEIVED on an AMM sell. */
  amount: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
  /** Present only for AMM trades. */
  amm?: {
    direction: "buy" | "sell";
    /** Shares gained on a buy, given up on a sell. */
    shares: bigint;
    /**
     * The part of the trade the pool kept. Carried because it is the only
     * record of what a liquidity provider earned, and because the executed
     * price is `(amount - fee) / shares` — using `amount` inflates it, and
     * since NO trades are plotted as `100 - p`, the two sides would drift in
     * opposite directions rather than merely being offset.
     */
    fee: bigint;
  };
}

/**
 * One liquidity movement: a deposit, or a post-settlement withdrawal.
 *
 * Kept apart from `TradeEvent` because providing liquidity is not a trade —
 * it takes no side and it moves the pool's depth rather than its price. What
 * makes it worth recording as an event at all is `totalLpShares`: with the
 * running total at each deposit, an ordered replay can say what fraction of
 * the pool each provider held at any block, and therefore attribute each
 * trade's fee to whoever was actually providing at the time.
 */
export interface LpEvent {
  /** Composite market key — see MarketBase.key. */
  marketKey: string;
  provider: `0x${string}`;
  direction: "add" | "withdraw";
  /** Collateral deposited on an add, received on a withdrawal. */
  amount: bigint;
  /** LP shares minted on an add, redeemed on a withdrawal. */
  lpShares: bigint;
  /** The market's total AFTER this deposit. Zero on a withdrawal. */
  totalLpShares: bigint;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

export interface SettledEvent {
  /** Composite market key — see MarketBase.key. */
  marketKey: string;
  outcome: Outcome;
  /** Minutes late for flights, price at 8 decimals for crypto. */
  observedValue: bigint;
  evidenceHash: `0x${string}`;
  /**
   * Carried like every other event type here. It was dropped originally
   * because the settlement card only needed the transaction — but without it a
   * settlement cannot be placed in time relative to anything else, which is
   * exactly what a lifecycle view is.
   */
  blockNumber: bigint;
  txHash: `0x${string}`;
  /**
   * The forwarder that delivered the report, taken from the `ReportProcessed`
   * log in the same transaction. Absent when that log could not be read — the
   * RPC drops logs silently, so a missing forwarder means "unknown", never
   * "the usual one".
   *
   * It is here because how a settlement was attested is a property of THAT
   * settlement, not of whatever the app is currently configured to watch. A
   * market settled by the DON was described as a local simulation for as long
   * as this was read from config instead.
   */
  forwarder?: `0x${string}`;
}

/** A connected wallet's stake in one market, with settlement applied. */
export interface Position {
  market: Market;
  yes: bigint;
  no: bigint;
  claimed: boolean;
  /** What claim() would pay right now — 0 once claimed, or while unresolved. */
  claimable: bigint;
  /**
   * What this position is owed in total, whether or not it has been claimed.
   * P&L must be measured against this: netting off already-claimed positions
   * would report a winning wallet as flat or losing.
   */
  entitlement: bigint;
  /**
   * The same two numbers, counting ONLY the shares — no pool claim folded in.
   *
   * `claimable` and `entitlement` above are deliberately whole-market totals,
   * which is what a portfolio row wants: one number per market. Anything that
   * drives a single BUTTON needs this pair instead, because the two halves are
   * claimed by two different calls behind two different one-shot guards.
   * Labelling `redeem()` with the total promises money that call will not pay,
   * and offering it to a provider holding no shares at all offers a call that
   * can only revert.
   */
  shareClaimable: bigint;
  /** Owed on the shares alone, claimed or not. See `shareClaimable`. */
  shareEntitlement: bigint;
  /**
   * Collateral actually put in, net of anything sold back.
   *
   * NOT `yes + no`. For a parimutuel market the two are the same number, but
   * for an AMM `yes`/`no` are SHARES — claims paying one unit each — so using
   * them as the cost basis both inflates the amount at risk and makes a
   * winning position score zero profit, since entitlement would be compared
   * against itself.
   */
  cost: bigint;
  status: "Open" | "Awaiting settlement" | "Won" | "Lost" | "Refundable" | "Claimed";
  /**
   * Present when this wallet has provided liquidity to the market.
   *
   * Deliberately separate from `yes`/`no`/`cost` rather than folded into them:
   * a provider's money is at risk in two different ways at once — the residual
   * shares the deposit handed them, which behave exactly like a trader's, and
   * a pro-rata claim on the pool, which does not. They are also claimed by two
   * different calls with two different one-shot guards, so a view that merges
   * them will offer one button where two are needed.
   */
  lp?: LpPosition;
}

/**
 * A liquidity position, valued.
 *
 * WHAT IMPERMANENT LOSS MEANS HERE. In a binary market with complete sets the
 * counterfactual is trivial: `d` collateral minted into `d` YES and `d` NO is
 * worth exactly `d` at settlement whatever the outcome, and not providing at
 * all is also worth `d`. So the benchmark is par, and there is no separate
 * divergence term to model the way a spot AMM needs one. The provider's whole
 * story is `pnl = value - deposited`, split into what the fees earned and what
 * the traders took: `impermanentLoss = feesEarned - pnl`.
 */
export interface LpPosition {
  shares: bigint;
  totalShares: bigint;
  /** Every deposit this wallet made, including the seed if they opened it. */
  deposited: bigint;
  /**
   * Fees attributed by an ordered replay of deposits and trades — NOT a slice
   * of the lifetime total at today's shares, which would retroactively pay a
   * late provider for volume that traded before they arrived.
   */
  feesEarned: bigint;
  /** The pro-rata claim: settled from chain, otherwise marked at the price. */
  poolValue: bigint;
  /** True once the pool claim has been drawn; the residual shares are separate. */
  withdrawn: boolean;
  /** `poolValue` is a mark rather than a claim while the market is open. */
  marked: boolean;
}

export interface TraderStats {
  address: `0x${string}`;
  staked: bigint;
  settledMarkets: number;
  wins: number;
  /** Net profit across settled markets; voids are neutral. */
  profit: bigint;
}
