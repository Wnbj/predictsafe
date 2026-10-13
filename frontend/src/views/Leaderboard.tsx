import { useMemo } from "react";
import { addressUrl } from "../lib/config";
import { formatSigned, formatToken, initials, shortAddress } from "../lib/format";
import { deriveTraders } from "../hooks/useChainData";
import type { LpEvent, Market, TradeEvent } from "../lib/types";

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
  const podium = traders.slice(0, 3);

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Leaderboard
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)" }}>
        Every wallet that has staked, ranked by realised profit across resolved markets. Built
        from on-chain events — no off-chain scoring.
      </p>

      {loading && traders.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>Loading trade history from Sepolia…</div>
      ) : traders.length === 0 ? (
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="heading" style={{ fontSize: 17 }}>
            No traders yet
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Once wallets stake on a market they will appear here.
          </div>
        </div>
      ) : (
        <>
          {podium.length > 0 && (
            <div className="grid-3" style={{ maxWidth: 900, marginBottom: "var(--space-6)" }}>
              {podium.map((t, i) => (
                <div
                  key={t.address}
                  className="card"
                  style={
                    i === 0
                      ? { boxShadow: "var(--shadow-md), inset 0 0 0 1px var(--color-accent)" }
                      : undefined
                  }
                >
                  <div className="eyebrow">Rank {i + 1}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar address={t.address} size={36} />
                    <div className="heading" style={{ fontSize: 17 }}>
                      {isYou(t.address) ? "You" : shortAddress(t.address)}
                    </div>
                  </div>
                  <div
                    className="muted-strong"
                    style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}
                  >
                    <span>
                      {t.wins}/{t.settledMarkets} won
                    </span>
                    <span
                      style={{
                        color: t.profit >= 0n ? "var(--color-accent-300)" : "var(--color-negative)",
                      }}
                    >
                      {formatSigned(t.profit)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="table-scroll">
            <table className="data" style={{ maxWidth: 900 }}>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Trader</th>
                  <th>Staked</th>
                  <th>Resolved</th>
                  <th>Won</th>
                  <th>Profit</th>
                </tr>
              </thead>
              <tbody>
                {traders.map((t, i) => (
                  <tr
                    key={t.address}
                    style={
                      isYou(t.address)
                        ? { boxShadow: "inset 2px 0 0 var(--color-accent)" }
                        : undefined
                    }
                  >
                    <td>{i + 1}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Avatar address={t.address} size={24} />
                        <a
                          href={addressUrl(t.address)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: "none" }}
                        >
                          {isYou(t.address) ? "You" : shortAddress(t.address)}
                        </a>
                      </div>
                    </td>
                    <td>{formatToken(t.staked)}</td>
                    <td>{t.settledMarkets}</td>
                    <td>{t.wins}</td>
                    <td
                      style={{
                        color: t.profit >= 0n ? "var(--color-accent-300)" : "var(--color-negative)",
                      }}
                    >
                      {formatSigned(t.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Avatar({ address, size }: { address: string; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--color-accent-800)",
        color: "var(--color-accent-100)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size < 30 ? 10 : 13,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials(address)}
    </div>
  );
}
