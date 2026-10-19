import { useMemo } from "react";
import { addressUrl } from "../lib/config";
import { formatSigned, formatToken, initials, shortAddress } from "../lib/format";
import { deriveTraders } from "../hooks/useChainData";
import type { LpEvent, Market, TradeEvent } from "../lib/types";

type Trader = ReturnType<typeof deriveTraders>[number];

/**
 * Every wallet that has staked, ranked by realised profit — in the wallet's
 * style: a headline, a podium for the top three, and a list with each
 * trader's record under their name.
 */
export function Leaderboard({
  loading,
  markets,
  tradeEvents,
  lpEvents,
  account,
}: {
  /** Trade history still arriving: an empty board would be a false "no traders". */
  loading: boolean;
  markets: Market[];
  tradeEvents: TradeEvent[];
  lpEvents: LpEvent[];
  account: string | null;
}) {
  const traders = useMemo(
    () => deriveTraders(markets, tradeEvents, lpEvents),
    [markets, tradeEvents, lpEvents],
  );

  const isYou = (a: string) => account !== null && a.toLowerCase() === account.toLowerCase();
  const name = (a: string) => (isYou(a) ? "You" : shortAddress(a));
  const staked = traders.reduce((s, t) => s + t.staked, 0n);
  const yourRank = account ? traders.findIndex((t) => isYou(t.address)) : -1;
  // Second, first, third: the winner stands in the middle.
  const podium = [traders[1], traders[0], traders[2]];

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Leaderboard
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)", maxWidth: 780 }}>
        Every wallet that has staked, ranked by realised profit across resolved markets. Built
        from on-chain events — no off-chain scoring.
      </p>

      <section className="wallet board" aria-label="Leaderboard">
        <div className="wallet-head">
          <div>
            <div className="eyebrow">Ranked by realised profit</div>
            <div className="wallet-total">
              {loading && traders.length === 0 ? "…" : `${traders.length} trader${traders.length === 1 ? "" : "s"}`}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {yourRank >= 0 ? `you are #${yourRank + 1}` : account ? "you have not staked yet" : "connect a wallet to find yourself"}
            </div>
          </div>
          <div className="positions-stats">
            <div>
              <span>Staked</span>
              <b>{formatToken(staked)}</b>
            </div>
            <div>
              <span>Markets</span>
              <b>{markets.length}</b>
            </div>
            <div className={traders[0] && traders[0].profit > 0n ? "accent" : undefined}>
              <span>Best</span>
              <b>{traders[0] ? formatSigned(traders[0].profit) : "—"}</b>
            </div>
          </div>
        </div>

        {loading && traders.length === 0 ? (
          <ul className="wallet-list">
            {[0, 1, 2].map((i) => (
              <li key={i} className="wallet-row">
                <span className="wallet-icon skeleton" />
                <div className="skeleton" style={{ height: 14, width: "40%" }} />
              </li>
            ))}
          </ul>
        ) : traders.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: "var(--space-4) 0" }}>
            No traders yet. Once wallets stake on a market they will appear here.
          </div>
        ) : (
          <>
            <div className="podium">
              {podium.map((t, i) =>
                t ? (
                  <a
                    key={t.address}
                    className={`podium-step place-${i === 1 ? 1 : i === 0 ? 2 : 3}${isYou(t.address) ? " you" : ""}`}
                    href={addressUrl(t.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="podium-medal">{i === 1 ? 1 : i === 0 ? 2 : 3}</span>
                    <Avatar address={t.address} size={i === 1 ? 56 : 44} />
                    <b>{name(t.address)}</b>
                    <span className={t.profit >= 0n ? "up" : "down"}>{formatSigned(t.profit)}</span>
                    <span className="muted">
                      {t.wins}/{t.settledMarkets} won
                    </span>
                  </a>
                ) : (
                  <div key={`empty-${i}`} className="podium-step empty" />
                ),
              )}
            </div>

            <ul className="wallet-list">
              {traders.map((t, i) => (
                <TraderRow key={t.address} t={t} rank={i + 1} you={isYou(t.address)} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function TraderRow({ t, rank, you }: { t: Trader; rank: number; you: boolean }) {
  const rate = t.settledMarkets > 0 ? t.wins / t.settledMarkets : 0;
  return (
    <li className={`wallet-row board-row${you ? " you" : ""}`}>
      <span className="board-rank">{rank}</span>
      <div className="wallet-row-main">
        <div className="wallet-row-name board-name">
          <Avatar address={t.address} size={26} />
          {you ? "You" : shortAddress(t.address)}
        </div>
        <div className="wallet-row-chains">
          <span className="muted">{formatToken(t.staked)} staked</span>
          <span className="muted">
            {t.wins}/{t.settledMarkets} won
          </span>
          <span className="board-rate" title={`${Math.round(rate * 100)}% of resolved markets won`}>
            <span style={{ width: `${Math.round(rate * 100)}%` }} />
          </span>
        </div>
      </div>
      <div className="wallet-row-value">
        <div className={t.profit > 0n ? "up" : t.profit < 0n ? "down" : undefined}>{formatSigned(t.profit)}</div>
        <div className="muted">{Math.round(rate * 100)}% win rate</div>
      </div>
      <a className="btn wallet-row-action" href={addressUrl(t.address)} target="_blank" rel="noreferrer" title="Open on Etherscan">
        Etherscan ↗
      </a>
    </li>
  );
}

/** Initials on a colour taken from the address, so the same wallet always looks the same. */
function Avatar({ address, size }: { address: string; size: number }) {
  const hue = parseInt(address.slice(2, 6), 16) % 360;
  return (
    <span
      className="board-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size < 30 ? 10 : size < 50 ? 13 : 16,
        background: `linear-gradient(135deg, hsl(${hue} 45% 42%), hsl(${(hue + 40) % 360} 40% 28%))`,
      }}
    >
      {initials(address)}
    </span>
  );
}
