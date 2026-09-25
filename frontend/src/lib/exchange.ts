import { formatUnits, parseAbi, type Address } from "viem";
import { chain, EXCHANGE_ADDRESS } from "./config";
import { publicClient, walletClientFor } from "./chain";

/**
 * The synthetic-asset exchange: buy and sell tokens of gold and an S&P 500
 * fund, priced by Chainlink Data Feeds.
 *
 * Everything here follows from one rule in the contract: an order fills at the
 * first NEW price published after it — never at a price anyone already knows.
 * So the page cannot show "the price you will get". It shows an estimate at the
 * latest price, says plainly that the fill will be at the next one, and says
 * when that is likely to be: within the hour for gold on a weekday, the next
 * day for the S&P 500, and not before the market reopens at a weekend.
 */

export const exchangeAbi = parseAbi([
  "function assetCount() view returns (uint256)",
  "function asset(uint32 assetId) view returns (string symbol, address feed, address token, uint8 feedDecimals, bool active)",
  "function orderCount() view returns (uint256)",
  "function order(uint256 orderId) view returns ((address trader, uint32 assetId, uint8 side, uint8 status, uint80 placedRound, uint64 placedAt, uint256 amountIn, uint256 amountOut, uint256 fee, uint80 fillRound, int256 fillPrice))",
  "function nextFill(uint256 orderId) view returns (bool found, uint80 round, int256 price)",
  "function reserveAvailable() view returns (uint256)",
  "function escrowedUsdc() view returns (uint256)",
  "function placeBuy(uint32 assetId, uint256 usdcIn) returns (uint256)",
  "function placeSell(uint32 assetId, uint256 tokensIn) returns (uint256)",
  "function fill(uint256[] orderIds)",
  "function cancel(uint256 orderId)",
]);

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80 roundId) view returns (uint80, int256, uint256, uint256, uint80)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

/** Mirrors the contract's constants. */
export const FEE_BPS = 30n;
export const CANCEL_AFTER_SECONDS = 7 * 24 * 60 * 60;
export const USDC_DECIMALS = 6;
export const ASSET_TOKEN_DECIMALS = 18;

/**
 * How far back the page looks for the last price that actually moved. A
 * weekend of hourly gold heartbeats is about 46 rounds; 60 covers it.
 */
const HISTORY_ROUNDS = 60;

// --- shapes -------------------------------------------------------------------

export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

export interface ExchangeAsset {
  id: number;
  symbol: string;
  /** What the page calls it. The contract only knows the feed symbol. */
  name: string;
  feed: Address;
  token: Address;
  feedDecimals: number;
  active: boolean;
  /** The feed's latest round — a heartbeat or a new price. */
  latest: FeedRound;
  /** The most recent round whose price differs from the round before it. */
  lastChange: FeedRound | null;
  /** Median seconds between rounds over the history read. */
  cadenceSeconds: number | null;
  totalSupply: bigint;
  /** The connected wallet's holding, 18 decimals. 0 when none is connected. */
  balance: bigint;
}

export type OrderSide = "buy" | "sell";
export type OrderStatus = "pending" | "filled" | "refunded";

export interface ExchangeOrder {
  id: number;
  trader: Address;
  assetId: number;
  side: OrderSide;
  status: OrderStatus;
  placedRound: bigint;
  placedAt: number;
  /** mUSDC for a buy, asset tokens for a sell. */
  amountIn: bigint;
  /** Asset tokens for a buy, mUSDC for a sell. 0 until filled. */
  amountOut: bigint;
  fee: bigint;
  fillRound: bigint;
  fillPrice: bigint;
  /** For a pending order: the price it would fill at now, if one exists. */
  ready: { round: bigint; price: bigint } | null;
}

export interface ExchangeState {
  assets: ExchangeAsset[];
  orders: ExchangeOrder[];
  /** mUSDC available to pay sellers right now. */
  reserve: bigint;
  /** mUSDC held for buy orders that have not filled. */
  escrowed: bigint;
}

const NAMES: Record<string, string> = { XAU: "Gold", CSPX: "S&P 500" };

// --- pure: the contract's arithmetic, mirrored ---------------------------------

/** `10 ** (18 + feedDecimals - 6)` — converts between mUSDC and asset tokens. */
const scaleFor = (feedDecimals: number) =>
  10n ** BigInt(ASSET_TOKEN_DECIMALS + feedDecimals - USDC_DECIMALS);

/** What a buy of `usdcIn` would receive at `price`. The same integer math as `_settle`. */
export function estimateBuy(usdcIn: bigint, price: bigint, feedDecimals: number) {
  if (price <= 0n || usdcIn <= 0n) return { fee: 0n, tokens: 0n };
  const fee = (usdcIn * FEE_BPS) / 10_000n;
  return { fee, tokens: ((usdcIn - fee) * scaleFor(feedDecimals)) / price };
}

/** What a sell of `tokensIn` would pay at `price`, before the reserve check. */
export function estimateSell(tokensIn: bigint, price: bigint, feedDecimals: number) {
  if (price <= 0n || tokensIn <= 0n) return { gross: 0n, fee: 0n, payout: 0n };
  const gross = (tokensIn * price) / scaleFor(feedDecimals);
  const fee = (gross * FEE_BPS) / 10_000n;
  return { gross, fee, payout: gross - fee };
}

/** The value of `tokens` at `price`, in mUSDC — for holdings, with no fee. */
export function valueOf(tokens: bigint, price: bigint, feedDecimals: number): bigint {
  return price > 0n ? (tokens * price) / scaleFor(feedDecimals) : 0n;
}

/**
 * The most recent round that carries a new price, from rounds sorted oldest
 * first. A round that repeats its predecessor is a heartbeat: it proves the
 * feed is alive, not that the market is.
 */
export function lastPriceChange(rounds: readonly FeedRound[]): FeedRound | null {
  for (let i = rounds.length - 1; i > 0; i--) {
    if (rounds[i]!.answer !== rounds[i - 1]!.answer) return rounds[i]!;
  }
  return null;
}

/** Median gap between consecutive rounds, sorted oldest first. */
export function medianGap(rounds: readonly FeedRound[]): number | null {
  const gaps = rounds.slice(1).map((r, i) => r.updatedAt - rounds[i]!.updatedAt).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;
}

export type FeedState = "moving" | "paused" | "closed";

/**
 * Whether the asset's price is moving, in words a visitor can act on.
 *
 * Decided by the PRICE, never the clock: at a weekend the feed keeps publishing
 * with fresh timestamps, and a staleness check on those would call a closed
 * market live.
 *
 * Three states rather than two, because of a Friday night in September. Gold
 * changed price at 22:05 UTC, then published again at 23:05 with the same
 * price — its market had closed for the weekend. Judged only by time since the
 * last change, the page kept saying "fills within about an hour" for another
 * two and a half hours, and orders placed then waited until Sunday night. A
 * latest round that repeats its predecessor is evidence on its own, the moment
 * it lands; it is `paused`. `closed` is the same thing confirmed by time.
 */
export function marketState(
  a: Pick<ExchangeAsset, "latest" | "lastChange" | "cadenceSeconds">,
  nowSeconds: number,
): { state: FeedState; moving: boolean; label: string; expectedWait: string } {
  const cadence = a.cadenceSeconds ?? 3600;
  const typicalWait = cadence <= 2 * 3600 ? "within about an hour" : "within about a day";

  if (!a.lastChange || nowSeconds - a.lastChange.updatedAt > cadence * 2.5) {
    return {
      state: "closed",
      moving: false,
      label: "Market closed — price unchanged",
      expectedWait: "when the price moves again",
    };
  }
  if (a.latest.roundId !== a.lastChange.roundId) {
    return {
      state: "paused",
      moving: false,
      label: "Last update repeated the price",
      expectedWait: "at the next new price — possibly not until the market reopens",
    };
  }
  return { state: "moving", moving: true, label: "Price moving", expectedWait: typicalWait };
}

/** One asset's line in the portfolio: what is held, and what is still waiting. */
export interface Holding {
  asset: ExchangeAsset;
  /** The holding at the feed's latest price, in mUSDC, before any fee. */
  value: bigint;
  pendingBuys: number;
  /** mUSDC committed to buy orders that have not filled. */
  pendingBuyUsdc: bigint;
  pendingSells: number;
  /** Asset tokens committed to sell orders that have not filled. */
  pendingSellTokens: bigint;
}

/**
 * Per asset: the wallet's holding and its orders still waiting. Assets with
 * neither are left out, so an empty list means "nothing here", not "zero".
 */
export function holdingsFor(state: ExchangeState, account: Address): Holding[] {
  const mine = state.orders.filter(
    (o) => o.status === "pending" && o.trader.toLowerCase() === account.toLowerCase(),
  );
  return state.assets.flatMap((asset) => {
    const own = mine.filter((o) => o.assetId === asset.id);
    const buys = own.filter((o) => o.side === "buy");
    const sells = own.filter((o) => o.side === "sell");
    if (asset.balance === 0n && own.length === 0) return [];
    return [{
      asset,
      value: valueOf(asset.balance, asset.latest.answer, asset.feedDecimals),
      pendingBuys: buys.length,
      pendingBuyUsdc: buys.reduce((s, o) => s + o.amountIn, 0n),
      pendingSells: sells.length,
      pendingSellTokens: sells.reduce((s, o) => s + o.amountIn, 0n),
    }];
  });
}

/** What an order is doing, in one line. */
export function orderLabel(o: ExchangeOrder): string {
  if (o.status === "filled") return "Filled";
  if (o.status === "refunded") return "Refunded";
  return o.ready ? "Ready — new price published" : "Waiting for the next new price";
}

/** Whether `account` may take this order back yet. */
export function canCancel(o: ExchangeOrder, account: Address | null, nowSeconds: number): boolean {
  return (
    o.status === "pending" &&
    account !== null &&
    o.trader.toLowerCase() === account.toLowerCase() &&
    nowSeconds >= o.placedAt + CANCEL_AFTER_SECONDS
  );
}

export function formatAssetAmount(tokens: bigint, symbol: string): string {
  const n = Number(formatUnits(tokens, ASSET_TOKEN_DECIMALS));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} s${symbol}`;
}

export function formatFeedPrice(answer: bigint, decimals: number): string {
  const n = Number(formatUnits(answer, decimals));
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- reads ----------------------------------------------------------------------

const exchange = { address: EXCHANGE_ADDRESS, abi: exchangeAbi } as const;

async function readHistory(feed: Address): Promise<FeedRound[]> {
  const [latestId] = await publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
  const phase = latestId >> 64n;
  const agg = latestId & ((1n << 64n) - 1n);
  const ids: bigint[] = [];
  for (let k = 0n; k < BigInt(HISTORY_ROUNDS) && agg - k >= 1n; k++) ids.push((phase << 64n) | (agg - k));
  const res = await publicClient.multicall({
    contracts: ids.map((id) => ({ address: feed, abi: feedAbi, functionName: "getRoundData", args: [id] }) as const),
    allowFailure: true,
  });
  return res
    .flatMap((r) =>
      r.status === "success" && Number(r.result[3]) > 0
        ? [{ roundId: r.result[0], answer: r.result[1], updatedAt: Number(r.result[3]) }]
        : [],
    )
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export async function readExchange(account: Address | null): Promise<ExchangeState> {
  const count = Number(await publicClient.readContract({ ...exchange, functionName: "assetCount" }));
  const [reserve, escrowed, orderCount] = await publicClient.multicall({
    contracts: [
      { ...exchange, functionName: "reserveAvailable" },
      { ...exchange, functionName: "escrowedUsdc" },
      { ...exchange, functionName: "orderCount" },
    ],
    allowFailure: false,
  });

  const rows = await publicClient.multicall({
    contracts: Array.from({ length: count }, (_, i) => ({ ...exchange, functionName: "asset", args: [i] }) as const),
    allowFailure: false,
  });

  const assets: ExchangeAsset[] = [];
  for (let i = 0; i < rows.length; i++) {
    const [symbol, feed, token, feedDecimals, active] = rows[i]!;
    const history = await readHistory(feed);
    const [supply, balance] = await publicClient.multicall({
      contracts: [
        { address: token, abi: erc20Abi, functionName: "totalSupply" },
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account ?? EXCHANGE_ADDRESS] },
      ],
      allowFailure: false,
    });
    assets.push({
      id: i,
      symbol,
      name: NAMES[symbol] ?? symbol,
      feed,
      token,
      feedDecimals,
      active,
      latest: history.at(-1) ?? { roundId: 0n, answer: 0n, updatedAt: 0 },
      lastChange: lastPriceChange(history),
      cadenceSeconds: medianGap(history),
      totalSupply: supply,
      balance: account ? balance : 0n,
    });
  }

  const n = Number(orderCount);
  const raw = n
    ? await publicClient.multicall({
        contracts: Array.from({ length: n }, (_, i) => ({ ...exchange, functionName: "order", args: [BigInt(i)] }) as const),
        allowFailure: false,
      })
    : [];
  const orders: ExchangeOrder[] = raw.map((o, id) => ({
    id,
    trader: o.trader,
    assetId: o.assetId,
    side: o.side === 0 ? "buy" : "sell",
    status: o.status === 0 ? "pending" : o.status === 1 ? "filled" : "refunded",
    placedRound: o.placedRound,
    placedAt: Number(o.placedAt),
    amountIn: o.amountIn,
    amountOut: o.amountOut,
    fee: o.fee,
    fillRound: o.fillRound,
    fillPrice: o.fillPrice,
    ready: null,
  }));

  const pending = orders.filter((o) => o.status === "pending");
  if (pending.length) {
    const next = await publicClient.multicall({
      contracts: pending.map((o) => ({ ...exchange, functionName: "nextFill", args: [BigInt(o.id)] }) as const),
      allowFailure: true,
    });
    next.forEach((r, i) => {
      if (r.status === "success" && r.result[0]) pending[i]!.ready = { round: r.result[1], price: r.result[2] };
    });
  }

  return { assets, orders, reserve, escrowed };
}

// --- writes ----------------------------------------------------------------------

export function sendPlaceBuy(account: Address, assetId: number, usdcIn: bigint) {
  return walletClientFor(account).writeContract({
    ...exchange, functionName: "placeBuy", args: [assetId, usdcIn], chain, account,
  });
}

export function sendPlaceSell(account: Address, assetId: number, tokensIn: bigint) {
  return walletClientFor(account).writeContract({
    ...exchange, functionName: "placeSell", args: [assetId, tokensIn], chain, account,
  });
}

/** Open to anyone: the fill price is fixed by each order, not by who calls. */
export function sendFill(account: Address, orderIds: number[]) {
  return walletClientFor(account).writeContract({
    ...exchange, functionName: "fill", args: [orderIds.map(BigInt)], chain, account,
  });
}

export function sendCancel(account: Address, orderId: number) {
  return walletClientFor(account).writeContract({
    ...exchange, functionName: "cancel", args: [BigInt(orderId)], chain, account,
  });
}
