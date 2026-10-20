import type { CSSProperties, ReactNode } from "react";
import type { CategoryId } from "./types";

/**
 * Category registry — the extension point for new market types.
 *
 * `flights`, `crypto`, `stocks`, `reserves` and `amm` are live, each backed by
 * its own contract. The rest
 * are declared but disabled: they render in the UI as "coming soon" rather
 * than being hidden, so the shape of the product is visible without inventing
 * markets that do not exist.
 *
 * To add a category: give it a `live: true` entry here, deploy a contract
 * inheriting ParimutuelMarket, and teach `readMarkets` how to load it. Market
 * cards, filters, portfolio and leaderboard all key off `categoryId` and need
 * no changes.
 */

const TAG: Record<string, CSSProperties> = {
  accent: { background: "#423a6a", color: "#f5f4ff" },
  accent2: { background: "#423e5d", color: "#f5f4ff" },
  neutral: { background: "#3f424d", color: "#f3f5fe" },
  outline: {
    background: "transparent",
    border: "1px solid var(--color-accent)",
    color: "var(--color-accent)",
  },
};

export interface CategoryDef {
  id: CategoryId;
  name: string;
  tagStyle: CSSProperties;
  /** Whether markets in this category actually exist on chain yet. */
  live: boolean;
  blurb: string;
  icon: (size: number) => ReactNode;
  /** Cover photo under the icon, from Pexels — see public/img/CREDITS.md. */
  image?: string;
}

const img = (file: string) => `${import.meta.env.BASE_URL}img/${file}`;

/**
 * A cover photo under a gradient of the page's background. `top`/`bottom` are
 * that gradient's opacity: light where only an icon sits on the photo, heavy
 * where text does. Without a photo it falls back to the plain surface
 * gradient, which is what "coming soon" categories still show.
 */
export function coverBackground(image: string | undefined, top = 0.1, bottom = 0.55): string {
  const plain = "linear-gradient(160deg, var(--color-surface), var(--color-neutral-900))";
  if (!image) return plain;
  return `linear-gradient(180deg, rgba(22, 24, 38, ${top}), rgba(22, 24, 38, ${bottom})), url("${image}") center / cover no-repeat`;
}

/**
 * A category icon that stays readable on a photo: a dark disc behind it, and
 * nothing extra where there is no photo to fight with.
 */
export function CoverIcon({ cat, size = 44 }: { cat: CategoryDef; size?: number }) {
  if (!cat.image) return <>{cat.icon(size)}</>;
  return (
    <span
      style={{
        display: "inline-flex",
        borderRadius: "50%",
        background: "rgba(22, 24, 38, 0.72)",
        boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.06), 0 4px 14px rgba(0, 0, 0, 0.45)",
      }}
    >
      {cat.icon(size)}
    </span>
  );
}

/** Photos for the exchange's assets, keyed by feed symbol. */
export const ASSET_IMAGES: Record<string, string> = {
  XAU: img("gold.jpg"),
  CSPX: img("spx.jpg"),
};

const planeIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path
      d="M22 33.5l20-7.5-4.5 9.5 3 7-4 1.5-4.5-6-6 2-.5 4-2.5.5-1-7-3-1.5z"
      fill="var(--color-accent)"
      opacity="0.9"
    />
  </svg>
);

const sportsIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path
      d="M32 14L32 22M18 32L26 32M38 32L46 32M32 42L32 50M22 20L27 26M42 20L37 26M22 44L27 38M42 44L37 38"
      stroke="var(--color-neutral-500)"
      strokeWidth="1.2"
    />
  </svg>
);

const cryptoIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <circle cx="32" cy="32" r="13" fill="none" stroke="var(--color-neutral-500)" strokeWidth="1" />
    <path
      d="M26 36l4-10 4 6 4-8"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const stocksIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path
      d="M21 39l7-8 5 4 10-12"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M39 23h5v5" fill="none" stroke="var(--color-accent)" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 44h24" stroke="var(--color-neutral-500)" strokeWidth="1" />
  </svg>
);

const reservesIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <ellipse cx="32" cy="24" rx="11" ry="4" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path d="M21 24v14c0 2.2 4.9 4 11 4s11-1.8 11-4V24" fill="none"
      stroke="var(--color-accent)" strokeWidth="1.6" />
    <path d="M21 31c0 2.2 4.9 4 11 4s11-1.8 11-4" fill="none"
      stroke="var(--color-neutral-500)" strokeWidth="1.2" />
  </svg>
);

const ammIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path d="M20 42c8 0 8-20 24-20" fill="none" stroke="var(--color-accent)" strokeWidth="1.8"
      strokeLinecap="round" />
    <circle cx="20" cy="42" r="2.6" fill="var(--color-accent)" />
    <circle cx="44" cy="22" r="2.6" fill="var(--color-accent)" />
  </svg>
);

const popIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path d="M27 23l14 9-14 9z" fill="var(--color-accent)" />
  </svg>
);

const currentIcon = (size: number) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
    <circle cx="32" cy="32" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
    <path
      d="M12 32h40M32 12v40M18 18c8 6 20 6 28 0M18 46c8-6 20-6 28 0"
      fill="none"
      stroke="var(--color-neutral-500)"
      strokeWidth="1"
    />
  </svg>
);

export const CATEGORIES: CategoryDef[] = [
  {
    id: "flights",
    name: "Flights",
    tagStyle: TAG.accent,
    live: true,
    blurb: "Flight-delay markets settled by a Chainlink CRE workflow.",
    icon: planeIcon,
    image: img("flights.jpg"),
  },
  {
    id: "sports",
    name: "Sports",
    tagStyle: TAG.accent2,
    live: true,
    blurb: "Football: home win, draw or away win — opened and settled by the DON.",
    icon: sportsIcon,
  },
  {
    id: "crypto",
    name: "Crypto",
    tagStyle: TAG.accent2,
    live: true,
    blurb: "BTC and ETH price levels, settled on median exchange data.",
    icon: cryptoIcon,
    image: img("crypto.jpg"),
  },
  {
    id: "stocks",
    name: "Stocks",
    tagStyle: TAG.accent,
    live: true,
    blurb: "Index and commodity levels, settled from Chainlink Data Feeds.",
    icon: stocksIcon,
    image: img("stocks.jpg"),
  },
  {
    id: "reserves",
    name: "Reserves",
    tagStyle: TAG.accent2,
    live: true,
    blurb: "Proof-of-Reserve and fund NAV levels, settled from Chainlink feeds.",
    icon: reservesIcon,
    image: img("reserves.jpg"),
  },
  {
    id: "amm",
    name: "AMM",
    tagStyle: TAG.outline,
    live: true,
    blurb: "Same questions, priced by a market maker — your price is locked when you buy.",
    icon: ammIcon,
    image: img("amm.jpg"),
  },
  {
    id: "pop",
    name: "Pop Culture",
    tagStyle: TAG.neutral,
    live: false,
    blurb: "Awards, releases, announcements.",
    icon: popIcon,
  },
  {
    id: "current",
    name: "Current Events",
    tagStyle: TAG.outline,
    live: false,
    blurb: "Policy, macro and the news.",
    icon: currentIcon,
  },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export function category(id: CategoryId): CategoryDef {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown category: ${id}`);
  return c;
}

export const LIVE_CATEGORIES = CATEGORIES.filter((c) => c.live);
