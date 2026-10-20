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

/**
 * Every time in the app is shown in Bulgarian time, wherever the reader is —
 * not the browser's zone. Contracts, questions on chain and settlement logs
 * stay in UTC; this is only how they are displayed.
 */
export const APP_TIME_ZONE = "Europe/Sofia";

export function formatTimestamp(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: APP_TIME_ZONE,
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Sofia wall-clock parts of an instant, plus its zone name (EET or EEST). */
function sofiaParts(ms: number): { hh: string; mm: string; month: string; day: number; zone: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: APP_TIME_ZONE,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    hh: parts.hour!,
    mm: parts.minute!,
    month: MONTHS[Number(parts.month) - 1]!,
    day: Number(parts.day),
    zone: parts.timeZoneName === "GMT+3" ? "EEST" : "EET",
  };
}

/** "01:18 EEST" — the clock time of an instant in Bulgaria. */
export function formatClock(seconds: number): string {
  const p = sofiaParts(seconds * 1000);
  return `${p.hh}:${p.mm} ${p.zone}`;
}

/**
 * Questions name their moment in UTC ("at 22:18 UTC on Oct 13"), because that
 * is the clock the contracts use. Shown, the same moment reads in Bulgarian
 * time ("at 01:18 EEST on Oct 14"). The question carries no year, so the one
 * closest to `nowSeconds` is taken.
 */
export function localTimes(text: string, nowSeconds = Date.now() / 1000): string {
  return text.replace(/\b(\d{2}):(\d{2}) UTC on ([A-Z][a-z]{2}) (\d{1,2})\b/g, (whole, hh, mm, mon, day) => {
    const month = MONTHS.indexOf(mon);
    if (month < 0) return whole;
    const now = nowSeconds * 1000;
    const year = new Date(now).getUTCFullYear();
    const ms = [year - 1, year, year + 1]
      .map((y) => Date.UTC(y, month, Number(day), Number(hh), Number(mm)))
      .reduce((best, t) => (Math.abs(t - now) < Math.abs(best - now) ? t : best));
    const p = sofiaParts(ms);
    return `${p.hh}:${p.mm} ${p.zone} on ${p.month} ${p.day}`;
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
