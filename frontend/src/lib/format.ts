import { formatUnits, parseUnits } from "viem";
import { TOKEN_DECIMALS, TOKEN_SYMBOL } from "./config";
import { MarketStatus, Outcome } from "./types";

/** Token amount → "12.5 mUSDC". Trims trailing zeros; keeps small values readable. */
export function formatToken(v: bigint, opts: { symbol?: boolean } = {}): string {
  const withSymbol = opts.symbol !== false;
  const raw = formatUnits(v, TOKEN_DECIMALS);
  const n = Number(raw);
  let body: string;
  if (n === 0) body = "0";
  else if (Math.abs(n) < 0.01) body = raw.replace(/0+$/, "").replace(/\.$/, "");
  else if (Math.abs(n) >= 1000) body = n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  else body = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return withSymbol ? `${body} ${TOKEN_SYMBOL}` : body;
}

export function formatSigned(v: bigint): string {
  const sign = v > 0n ? "+" : "";
  return `${sign}${formatToken(v)}`;
}

export function parseToken(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  try {
    return parseUnits(trimmed, TOKEN_DECIMALS);
  } catch {
    return null;
  }
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function initials(a: string): string {
  return a.slice(2, 4).toUpperCase();
}

/** YYYYMMDD int (as stored on-chain) → "15 Jan 2024". */
export function formatDepartureDate(yyyymmdd: number): string {
  const s = String(yyyymmdd);
  if (s.length !== 8) return s;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return s;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatTimestamp(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human "closes in" / "closed" phrasing relative to now. */
export function formatRelative(targetSeconds: number, nowSeconds: number): string {
  const delta = targetSeconds - nowSeconds;
  const past = delta < 0;
  const abs = Math.abs(delta);
  const mins = Math.floor(abs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  let body: string;
  if (days > 0) body = `${days}d`;
  else if (hours > 0) body = `${hours}h`;
  else if (mins > 0) body = `${mins}m`;
  else body = "<1m";

  return past ? `${body} ago` : `in ${body}`;
}

export function formatPercent(p: number | null): string {
  return p === null ? "—" : `${p.toFixed(0)}%`;
}

/** Crypto strike and settlement prices carry 8 decimals, as on chain. */
const PRICE_DECIMALS = 100_000_000n;

export function formatUsd(scaled: bigint): string {
  const whole = scaled / PRICE_DECIMALS;
  const cents = Number((scaled % PRICE_DECIMALS) / 1_000_000n);
  return `$${whole.toLocaleString()}.${cents.toString().padStart(2, "0")}`;
}

/**
 * A market's strike or observed value, in the unit that market actually
 * measures.
 *
 * Crypto and stock markets are quoted in dollars. A reserve market is not: its
 * level is a COUNT OF TOKENS or fund shares — stETH Proof of Reserves reports
 * 9,505,650.86 stETH, not $9.5m — so prefixing it with a currency symbol would
 * state a figure the feed never published.
 */
export function formatMarketValue(categoryId: string, scaled: bigint): string {
  // A football market records the result as a code, not a measurement.
  if (categoryId === "sports") return ["—", "home win", "draw", "away win", "void"][Number(scaled)] ?? "—";
  // A flight's "value" is its arrival delay in whole minutes, unscaled. Read as
  // an 8-decimal price it printed every observed delay on /live as "$0.00".
  if (categoryId === "flights") return `${scaled} min`;
  if (categoryId === "reserves") return formatFine(scaled);
  return formatUsd(scaled);
}

/**
 * A reserve level or fund NAV, with as many places as it carries, up to four.
 * A NAV strike sits a fraction of a cent above today's value — USTB grows
 * about $0.0011 a day — and showing it to the cent would print the strike as
 * a number the market is already past.
 */
function formatFine(scaled: bigint): string {
  const whole = scaled / PRICE_DECIMALS;
  const frac = (scaled % PRICE_DECIMALS).toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole.toLocaleString()}.${frac.padEnd(2, "0")}`;
}

/** The 8-decimal on-chain price as a plain number, for comparing against spot. */
export function toUsdNumber(scaled: bigint): number {
  return Number(scaled) / 1e8;
}

export function formatUsdNumber(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/*
 * Enum → the word shown on screen. These live here rather than with the
 * pricing maths because that is all they are: neither depends on which pricing
 * model a market uses, and both are pure display.
 */

export function outcomeLabel(o: Outcome): string {
  switch (o) {
    case Outcome.Yes:
      return "Yes";
    case Outcome.No:
      return "No";
    case Outcome.Void:
      return "Void";
    default:
      return "—";
  }
}

export function statusLabel(s: MarketStatus): string {
  switch (s) {
    case MarketStatus.Open:
      return "Open";
    case MarketStatus.Locked:
      return "Locked";
    case MarketStatus.SettlementRequested:
      return "Settling";
    case MarketStatus.Settled:
      return "Settled";
    case MarketStatus.Void:
      return "Void";
    default:
      return "Unknown";
  }
}
