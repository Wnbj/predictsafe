import type { CryptoAsset } from "./chain";

/**
 * The terms of a market someone opens from the app, worked out in one place
 * so the form shows exactly what the transaction will send.
 */

export interface Horizon {
  label: string;
  /** Seconds from now to expiry. */
  seconds: number;
  /**
   * Seconds before expiry that staking closes. Staking right up to expiry
   * would let anyone watching the price stake on a result already decided;
   * the gap grows with the horizon because so does how far the price can
   * drift in it.
   */
  closeBefore: number;
}

export const HORIZONS: Horizon[] = [
  { label: "15 minutes", seconds: 15 * 60, closeBefore: 5 * 60 },
  { label: "1 hour", seconds: 60 * 60, closeBefore: 15 * 60 },
  { label: "4 hours", seconds: 4 * 3600, closeBefore: 3600 },
  { label: "24 hours", seconds: 24 * 3600, closeBefore: 4 * 3600 },
];

/** Strikes snap to a round number a person would actually type. */
export const STRIKE_STEP: Record<CryptoAsset, number> = { BTC: 100, ETH: 10 };

export function roundStrike(asset: CryptoAsset, spot: number): number {
  const step = STRIKE_STEP[asset];
  return Math.round(spot / step) * step;
}

export interface CryptoMarketTerms {
  question: string;
  /** 8 decimals, as CryptoMarket stores it. */
  strike: bigint;
  closeTime: number;
  expiryTime: number;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;

/**
 * Expiry lands on a whole minute — settlement reads one-minute candles, and a
 * market expiring at :17:43 would be judged on a candle that does not start
 * there — and the question names it in UTC, the clock every contract and
 * settlement log uses, rather than the reader's local zone.
 */
export function cryptoMarketTerms(
  asset: CryptoAsset,
  strikeUsd: number,
  horizon: Horizon,
  nowSeconds: number,
): CryptoMarketTerms {
  const expiryTime = Math.ceil((nowSeconds + horizon.seconds) / 60) * 60;
  const closeTime = expiryTime - horizon.closeBefore;
  const at = new Date(expiryTime * 1000);
  const when = `${at.toISOString().slice(11, 16)} UTC on ${at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })}`;
  return {
    question: `Will ${asset} be at or above ${usd(strikeUsd)} at ${when}?`,
    strike: BigInt(Math.round(strikeUsd * 1e8)),
    closeTime,
    expiryTime,
  };
}
