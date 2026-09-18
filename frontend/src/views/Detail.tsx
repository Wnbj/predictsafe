import { useMemo, useState } from "react";
import { category } from "../lib/categories";
import { addressUrl, ATTESTATION_LABEL, txUrl, attestationFor} from "../lib/config";
import { formatDepartureDate, formatMarketValue, formatPercent, formatTimestamp, formatToken, outcomeLabel, shortAddress, statusLabel } from "../lib/format";
import {
  impliedYesPercent,
  isOneSided,

  totalPool,
} from "../lib/pricing";
import {
  isPriceMarket,
  MarketStatus,
  Outcome,
  priceAssetLabel,
  type Market,
  type Position,
  type LpEvent,
  type SettledEvent,
  type TradeEvent,
} from "../lib/types";
import { ladderFor } from "../lib/events";
import { StrikeLadder } from "../components/StrikeLadder";
import { Sparkline } from "../components/Sparkline";
import { Countdown } from "../components/Countdown";
import { LivePrice } from "../components/LivePrice";
import { PriceChart } from "../components/PriceChart";
import { MarketCard } from "../components/MarketCard";
import { TradePanel } from "../components/TradePanel";
import { LiquidityPanel } from "../components/LiquidityPanel";
import { Stat } from "../components/Stat";
import type { WalletState } from "../hooks/useWallet";

type Tab = "overview" | "activity" | "rules";

export function Detail({
  market,
  markets,
  tradeEvents,
  settledEvents,
  lpEvents,
  positions,
  wallet,
  balance,
  allowances,
  now,
  onBack,
  onOpenMarket,
  onRefresh,
}: {
  market: Market;
  markets: Market[];
  tradeEvents: TradeEvent[];
  settledEvents: SettledEvent[];
  lpEvents: LpEvent[];
  positions: Position[];
  wallet: WalletState;
  balance: bigint;
  allowances: Map<string, bigint>;
  now: number;
  onBack: () => void;
  onOpenMarket: (key: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const cat = category(market.categoryId);
  const yes = impliedYesPercent(market);

  const marketStakes = useMemo(
    () =>
      tradeEvents
        .filter((e) => e.marketKey === market.key)
        .sort((a, b) => Number(b.blockNumber - a.blockNumber)),
    [tradeEvents, market.key],
  );

  /**
   * Traders AND providers. Counting only trade events made anyone who supplied
   * the liquidity invisible on the market they are underwriting — which, with
   * one provider per market, meant the counterparty never appeared at all.
   */
  const backers = useMemo(() => {
    const who = new Set(marketStakes.map((e) => e.user.toLowerCase()));
    for (const e of lpEvents) {
      if (e.marketKey === market.key && e.direction === "add") who.add(e.provider.toLowerCase());
    }
    return who.size;
  }, [marketStakes, lpEvents, market.key]);

  const providers = useMemo(() => {
    const who = new Set<string>();
    for (const e of lpEvents) {
      if (e.marketKey === market.key && e.direction === "add") who.add(e.provider.toLowerCase());
    }
    return who.size;
  }, [lpEvents, market.key]);

  const ladder = useMemo(() => ladderFor(market, markets), [market, markets]);

  const settlement = settledEvents.find((e) => e.marketKey === market.key);
  const position = positions.find((p) => p.market.key === market.key);
  // Sibling rungs are already shown as the ladder, so exclude them here —
  // otherwise the same markets appear twice on one page.
  const ladderKeys = new Set(ladder?.rungs.map((m) => m.key) ?? []);
  const related = markets
    .filter(
      (m) => m.categoryId === market.categoryId && m.key !== market.key && !ladderKeys.has(m.key),
    )
    .slice(0, 3);

  return (
    <div className="page" style={{ paddingTop: 40, maxWidth: 1300 }}>
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onBack();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          marginBottom: "var(--space-4)",
          textDecoration: "none",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        Back to markets
      </a>

      <div>
        <span className="tag" style={{ ...cat.tagStyle, marginBottom: "var(--space-2)" }}>
          {cat.name}
        </span>
      </div>
      <h1
        className="heading"
        style={{ fontSize: 36, lineHeight: 1.1, maxWidth: 760, margin: "0 0 var(--space-2)" }}
      >
        {market.question}
      </h1>

      <div className="detail-grid">
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "var(--space-4)",
              marginBottom: "var(--space-4)",
              flexWrap: "wrap",
            }}
          >
            {/* An em-dash at 44px reads as a stray rule, not as "no data yet". */}
            {yes === null ? (
              <div className="heading muted" style={{ fontSize: 22 }}>
                No odds yet
              </div>
            ) : (
              <>
                <div className="heading" style={{ fontSize: 44, color: "var(--color-accent)" }}>
                  {formatPercent(yes)}
                </div>
                {/* A compact trend chip next to the number it explains, rather
                    than a full-width chart with nothing around it to anchor
                    what it is. */}
                <div
                  title="Implied chance of Yes over time"
                  style={{ width: 76, height: 32, flexShrink: 0 }}
                >
                  <Sparkline market={market} events={tradeEvents} height={32} strokeWidth={1.5} />
                </div>
              </>
            )}
            <div className="muted" style={{ fontSize: 13 }}>
              {yes === null ? "first stake sets the price" : "implied chance of Yes"} ·{" "}
              {formatToken(totalPool(market))} staked
              {market.status !== MarketStatus.Open && ` · ${statusLabel(market.status)}`}
            </div>
          </div>

          {market.status === MarketStatus.Open && (
            <div
              style={{
                display: "flex",
                gap: "var(--space-6)",
                flexWrap: "wrap",
                alignItems: "baseline",
                marginBottom: "var(--space-4)",
              }}
            >
              <Countdown market={market} size={15} />
              <LivePrice market={market} size={15} />
            </div>
          )}

          {isPriceMarket(market) && <PriceChart market={market} />}

          {ladder && (
            <div className="card" style={{ marginTop: "var(--space-4)" }}>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: "var(--space-2)",
                }}
              >
                All strikes at this expiry
              </div>
              <StrikeLadder event={ladder} selectedKey={market.key} onOpen={onOpenMarket} />
              <p className="muted-strong" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
                Same question, same moment, different strike. Each rung is its own market — pick
                the one you actually have a view on.
              </p>
            </div>
          )}

          {settlement && (
            <div
              className="card"
              style={{ marginTop: "var(--space-4)", boxShadow: "var(--shadow-md)" }}
            >
              <div className="eyebrow">Settled by Chainlink CRE</div>
              {/*
                * The same sentence the live pipeline uses, from the same
                * constant — this card said "Settled by Chainlink CRE" alone on
                * a project that has never run against a real DON, and two
                * places claiming different things about the same event is how
                * one of them quietly stays wrong.
                */}
              {/*
                * From the forwarder that delivered THIS settlement, not from
                * whatever the app is configured to watch. The global label
                * described a market the DON had just settled as a local
                * simulation, because config still named the mock — the same
                * mistake the flag before it made, one layer further in.
                */}
              <div className="muted" style={{ fontSize: 11 }}>
                {settlement.forwarder ? attestationFor(settlement.forwarder) : ATTESTATION_LABEL}
              </div>
              <div style={{ display: "flex", gap: "var(--space-8)", flexWrap: "wrap" }}>
                <Stat label="Outcome" value={outcomeLabel(settlement.outcome)} />
                {market.categoryId === "flights" ? (
                  <>
                    <Stat
                      label="Observed delay"
                      value={
                        settlement.outcome === Outcome.Void
                          ? "—"
                          : `${settlement.observedValue} min`
                      }
                    />
                    <Stat label="Threshold" value={`${market.thresholdMinutes} min`} />
                  </>
                ) : (
                  <>
                    <Stat
                      label="Observed price"
                      value={
                        settlement.outcome === Outcome.Void
                          ? "—"
                          : formatMarketValue(market.categoryId, settlement.observedValue)
                      }
                    />
                    <Stat label="Strike" value={formatMarketValue(market.categoryId, market.strikePrice)} />
                  </>
                )}
              </div>
              <a
                href={txUrl(settlement.txHash)}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: "var(--color-accent)" }}
              >
                Settlement transaction ↗
              </a>
              <div className="muted-strong" style={{ fontSize: 11, wordBreak: "break-all" }}>
                Evidence hash {settlement.evidenceHash}
              </div>
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: "var(--space-4)",
              borderBottom: "1px solid var(--color-divider)",
              margin: "var(--space-6) 0 var(--space-4)",
            }}
          >
            {(["overview", "activity", "rules"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  cursor: "pointer",
                  background: "transparent",
                  border: "none",
                  fontFamily: "var(--font-heading)",
                  fontWeight: "var(--font-heading-weight)" as never,
                  fontSize: 14,
                  padding: "8px 0",
                  textTransform: "capitalize",
                  color: tab === t ? "var(--color-accent)" : "var(--color-text)",
                  opacity: tab === t ? 1 : 0.7,
                  borderBottom: `2px solid ${tab === t ? "var(--color-accent)" : "transparent"}`,
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div>
              <p style={{ maxWidth: 600, opacity: 0.85, margin: 0 }}>
                {market.categoryId === "flights" ? (
                  <>
                    Resolves <strong>Yes</strong> if flight {market.flightIata} on{" "}
                    {formatDepartureDate(market.departureDate)} arrives at least{" "}
                    {market.thresholdMinutes} minutes late, or is cancelled or diverted. Resolves{" "}
                    <strong>No</strong> if it lands less than {market.thresholdMinutes} minutes
                    late.
                  </>
                ) : (
                  <>
                    Resolves <strong>Yes</strong> if {priceAssetLabel(market)} is at or above{" "}
                    {formatMarketValue(market.categoryId, market.strikePrice)} at {formatTimestamp(market.expiryTime)}.
                    Resolves <strong>No</strong> if it is below.
                  </>
                )}
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-8)",
                  marginTop: "var(--space-4)",
                  flexWrap: "wrap",
                }}
              >
                <Stat label="Pool" value={formatToken(totalPool(market))} />
                <Stat label="Backers" value={String(backers)} />
                {market.categoryId === "amm" && (
                  <Stat
                    label={providers === 1 ? "Liquidity provider" : "Liquidity providers"}
                    value={String(providers)}
                  />
                )}
                {market.categoryId !== "flights" && (
                  <Stat label="Strike" value={formatMarketValue(market.categoryId, market.strikePrice)} />
                )}
                <Stat label="Closes" value={formatTimestamp(market.closeTime)} />
                <Stat label="Settleable from" value={formatTimestamp(market.settleAfter)} />
              </div>
              {isOneSided(market) && market.status === MarketStatus.Open && (
                <p style={{ fontSize: 13, color: "var(--color-accent-300)", marginTop: "var(--space-4)" }}>
                  Only one side is backed. A one-sided book cannot pay out, so this market would
                  void and refund everyone at settlement.
                </p>
              )}
            </div>
          )}

          {tab === "activity" && (
            <div style={{ maxWidth: 620 }}>
              {marketStakes.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  No stakes on this market yet.
                </p>
              ) : (
                marketStakes.map((e) => (
                  <div
                    key={`${e.txHash}-${e.user}-${e.amount}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "var(--space-2) 0",
                      borderBottom: "1px solid var(--color-divider)",
                      fontSize: 13,
                    }}
                  >
                    <a
                      href={addressUrl(e.user)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "none" }}
                    >
                      {shortAddress(e.user)}
                    </a>
                    <span className="muted">
                      {/* An AMM trade is a purchase at a price, and can run in
                          reverse — calling a sell a "stake" would describe the
                          opposite of what happened. */}
                      {e.amm
                        ? `${e.amm.direction === "buy" ? "bought" : "sold"} ${formatToken(
                            e.amm.shares,
                            // Shares are not currency — they are claims that
                            // pay one unit each if right. Labelling them mUSDC
                            // states a figure roughly twice the money involved.
                            { symbol: false },
                          )} ${e.isYes ? "Yes" : "No"} shares`
                        : `staked ${e.isYes ? "Yes" : "No"}`}
                    </span>
                    <a
                      href={txUrl(e.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "none" }}
                    >
                      {e.amm?.direction === "sell" ? "+" : ""}
                      {formatToken(e.amount)}
                    </a>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "rules" && (
            <div style={{ maxWidth: 620, opacity: 0.85, fontSize: 14 }}>
              <p style={{ marginTop: 0 }}>
                Resolution rules are encoded on chain, so the oracle has no discretion:
              </p>
              <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                {market.categoryId === "flights" ? (
                  <>
                    <li>
                      <strong>Yes</strong> — arrival delay ≥ {market.thresholdMinutes} minutes, or
                      the flight is cancelled or diverted.
                    </li>
                    <li>
                      <strong>No</strong> — arrival delay &lt; {market.thresholdMinutes} minutes.
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      <strong>Yes</strong> — {priceAssetLabel(market)} at or above{" "}
                      {formatMarketValue(market.categoryId, market.strikePrice)} at expiry.
                    </li>
                    <li>
                      <strong>No</strong> — below {formatMarketValue(market.categoryId, market.strikePrice)} at expiry.
                    </li>
                  </>
                )}
                <li>
                  <strong>Void</strong> — the data is unavailable, the sources disagree, or only
                  one side of the book is backed. Everyone is refunded their own stake.
                </li>
              </ul>
              <p>
                Anyone may call <code>requestSettlement()</code> once the settle-after time passes.
                That emits the log a Chainlink CRE workflow listens for; the network fetches the
                result, reaches consensus, and writes a signed report back to{" "}
                <code>onReport()</code>. Payouts are parimutuel: the winning side splits the entire
                pot in proportion to stake.
              </p>
              {market.categoryId === "crypto" && (
                <p>
                  The settlement price is the close of the one-minute candle containing expiry,
                  taken as the median across Coinbase, Kraken and Bitstamp. A closed candle is
                  used rather than a live quote so every oracle node reads the same number no
                  matter when it runs. If the venues disagree about which side of the strike the
                  price landed, the market voids rather than picking a winner.
                </p>
              )}
              {market.categoryId === "stocks" && (
                <>
                  <p>
                    The settlement price comes from the Chainlink {market.symbol}/USD Data Feed —
                    the round in force at expiry, read at the block the settlement request was
                    mined in. Pinning the block is what lets every oracle node read the same
                    number instead of whatever the chain head happened to be when each one asked.
                  </p>
                  <p>
                    A feed keeps publishing when the exchange behind it is closed, repeating the
                    last price with a fresh timestamp. So this market <strong>voids</strong> if
                    the price did not change between staking closing and expiry: a market whose
                    answer never moved while it was live was decided before the last stake was
                    placed. It also voids if the round at expiry is more than{" "}
                    {Math.round(market.maxStaleness / 3600)} hours old.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div>
          <TradePanel
            market={market}
            wallet={wallet}
            balance={balance}
            allowance={allowances.get(market.contract) ?? 0n}
            position={position}
            now={now}
            onDone={onRefresh}
          />
          <LiquidityPanel
            market={market}
            wallet={wallet}
            balance={balance}
            allowance={allowances.get(market.contract) ?? 0n}
            position={position}
            now={now}
            onDone={onRefresh}
          />
        </div>
      </div>

      {related.length > 0 && (
        <div style={{ marginTop: "var(--space-8)" }}>
          <h3 className="heading" style={{ fontSize: 22, margin: "0 0 var(--space-4)" }}>
            More in {cat.name}
          </h3>
          <div className="grid-3">
            {related.map((m) => (
              <MarketCard key={m.key} market={m} events={tradeEvents} onOpen={onOpenMarket} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

