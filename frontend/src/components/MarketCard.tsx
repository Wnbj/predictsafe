import { category, CoverIcon, coverBackground } from "../lib/categories";
import { formatMarketValue, formatPercent, formatTimestamp, formatToken, statusLabel } from "../lib/format";
import { competitionName, matchTitle } from "../lib/sports";
import { impliedYesPercent, isOneSided, totalPool } from "../lib/pricing";
import {
  isPriceMarket,
  MarketStatus,
  priceAssetLabel,
  type Market,
  type TradeEvent,
} from "../lib/types";
import { ladderTitle, type MarketEvent } from "../lib/events";
import { resolutionOf } from "../lib/resolution";
import { StrikeLadder } from "./StrikeLadder";
import { Countdown } from "./Countdown";
import { LivePrice } from "./LivePrice";
import { Sparkline } from "./Sparkline";

export function MarketCard({
  market,
  events,
  ladder,
  onOpen,
}: {
  market: Market;
  events: TradeEvent[];
  /** When set, this card stands for a whole strike ladder rather than one market. */
  ladder?: MarketEvent;
  onOpen: (key: string) => void;
}) {
  const cat = category(market.categoryId);
  const yes = impliedYesPercent(market);
  // Round once, then derive No from the rounded Yes: rounding each side on its
  // own showed 32.5 / 67.5 as "Yes 33% · No 68%", a book that sums to 101%.
  const yesShown = yes === null ? null : Math.round(yes);
  const no = yesShown === null ? null : 100 - yesShown;
  // Once the answer is known the card states it; the odds it closed at are a
  // forecast and stay on the market's own page.
  const resolution = resolutionOf(market);

  /**
   * A ladder card stands for five markets, so quoting one rung's strike in the
   * headline states a question narrower than the card actually offers. There
   * is no event title on chain — every question embeds its own strike — so the
   * shared question is recovered by removing the price from it.
   */
  const title =
    market.categoryId === "sports"
      ? matchTitle(market)
      : ladder
        ? ladderTitle(market.question)
        : market.question;

  return (
    <div
      className="card card-interactive"
      onClick={() => onOpen(market.key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(market.key);
        }
      }}
    >
      <div
        style={{
          margin: "calc(-1 * var(--space-3)) calc(-1 * var(--space-3)) 0",
          height: 110,
          borderRadius: "var(--radius-md) var(--radius-md) 0 0",
          background: coverBackground(cat.image),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CoverIcon cat={cat} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span className="tag" style={cat.tagStyle}>
          {cat.name}
        </span>
        <span
          className="muted"
          style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
        >
          <ClockIcon />
          {market.status === MarketStatus.Open ? (
            <Countdown market={market} size={11} showLabel={false} />
          ) : (
            statusLabel(market.status)
          )}
        </span>
      </div>

      <div className="heading" style={{ fontSize: 17, lineHeight: 1.25 }}>
        {title}
      </div>

      {market.categoryId === "sports" && (
        <div className="muted" style={{ fontSize: 12 }}>
          {competitionName(market.match.competition)} · kick-off {formatTimestamp(market.match.kickoff)}
        </div>
      )}

      {/* Crypto questions read alike at a glance, so surface the term that
          actually distinguishes them. */}
      {isPriceMarket(market) && (
        <div className="muted" style={{ fontSize: 12 }}>
          {priceAssetLabel(market)}
          {ladder
            ? ` · ${ladder.rungs.length} strikes`
            : ` · strike ${formatMarketValue(market.categoryId, market.strikePrice)}`}
        </div>
      )}

      {!resolution && <LivePrice market={market} size={12} />}

      {resolution && (!ladder || market.categoryId === "sports") && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            background: "color-mix(in srgb, var(--color-text) 5%, transparent)",
          }}
        >
          <span
            className="heading"
            style={{
              fontSize: 15,
              // A match card names the winner whichever of its three
              // markets it features, so it is never coloured as a loss.
              color:
                resolution.tone === "void"
                  ? "var(--color-neutral-400)"
                  : resolution.tone === "yes" || market.categoryId === "sports"
                    ? "var(--color-accent-300)"
                    : "var(--color-negative)",
            }}
          >
            {resolution.headline}
          </span>
          {resolution.detail && (
            <span className="muted" style={{ fontSize: 12 }}>
              {resolution.detail}
            </span>
          )}
        </div>
      )}

      {ladder ? (
        <StrikeLadder event={ladder} onOpen={onOpen} compact />
      ) : resolution ? null : (
        <>
          <Sparkline market={market} events={events} />
          <div style={{ display: "flex", height: 22, borderRadius: 5, overflow: "hidden" }}>
            <div style={{ width: `${yes ?? 50}%`, background: "var(--color-accent)" }} />
            <div style={{ width: `${no ?? 50}%`, background: "var(--color-neutral-700)" }} />
          </div>
        </>
      )}

      <div
        className="muted-strong"
        style={{
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 4,
          fontSize: 11,
        }}
      >
        <span style={{ whiteSpace: "nowrap" }}>
          {ladder
            ? market.categoryId === "sports"
              ? "Home · Draw · Away"
              : `${ladder.rungs.length} strikes`
            : resolution
              ? ""
              : yes === null
                ? "No stakes yet"
                : `Yes ${formatPercent(yesShown)} · No ${formatPercent(no)}`}
        </span>
        <span style={{ whiteSpace: "nowrap" }}>{formatToken(totalPool(market))} pool</span>
      </div>

      {isOneSided(market) && market.status === MarketStatus.Open && (
        <div style={{ fontSize: 11, color: "var(--color-accent-300)" }}>
          One-sided — voids unless the other side is backed
        </div>
      )}
    </div>
  );
}

export function ClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}
