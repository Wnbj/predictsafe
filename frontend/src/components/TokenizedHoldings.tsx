import type { Address } from "viem";
import { formatToken } from "../lib/format";
import {
  formatAssetAmount,
  formatFeedPrice,
  holdingsFor,
  marketState,
} from "../lib/exchange";
import { useExchange } from "../hooks/useExchange";

/**
 * The portfolio's view of the exchange: tokens held and orders still waiting.
 *
 * Kept apart from the market positions above it, and out of their totals, on
 * purpose. A stake is a claim on a pot that settles once; a token is a claim on
 * a reserve at whatever the feed says next. Adding the two into one "total"
 * would sum things that are not the same kind of money.
 */
export function TokenizedHoldings({ account, onOpenTrade }: { account: Address; onOpenTrade: () => void }) {
  const { state, error, now } = useExchange(account);

  return (
    <section style={{ marginTop: "var(--space-8)", maxWidth: 1200 }}>
      <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>Tokenized assets</div>

      {error && (
        <div style={{ color: "var(--color-negative)", fontSize: 13 }}>Could not read the exchange: {error}</div>
      )}

      {!state ? (
        !error && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>
      ) : (
        (() => {
          const rows = holdingsFor(state, account);
          if (rows.length === 0) {
            return (
              <div className="card" style={{ maxWidth: 520 }}>
                <div className="muted" style={{ fontSize: 13 }}>
                  No synthetic gold or S&amp;P 500 yet.{" "}
                  <button className="linklike" onClick={onOpenTrade} style={{ color: "var(--color-accent)" }}>
                    Trade →
                  </button>
                </div>
              </div>
            );
          }
          return (
            <>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Holding</th>
                      <th>Latest price</th>
                      <th>Value</th>
                      <th>Waiting to fill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((h) => {
                      const m = marketState(h.asset, now);
                      const waiting = [
                        h.pendingBuys > 0 &&
                          `${h.pendingBuys} buy${h.pendingBuys === 1 ? "" : "s"} · ${formatToken(h.pendingBuyUsdc)}`,
                        h.pendingSells > 0 &&
                          `${h.pendingSells} sell${h.pendingSells === 1 ? "" : "s"} · ${formatAssetAmount(h.pendingSellTokens, h.asset.symbol)}`,
                      ].filter(Boolean);
                      return (
                        <tr key={h.asset.id}>
                          <td>
                            Synthetic {h.asset.name} <span className="muted-strong">s{h.asset.symbol}</span>
                          </td>
                          <td>{h.asset.balance > 0n ? formatAssetAmount(h.asset.balance, h.asset.symbol) : "—"}</td>
                          <td>{formatFeedPrice(h.asset.latest.answer, h.asset.feedDecimals)}</td>
                          <td>{h.asset.balance > 0n ? formatToken(h.value) : "—"}</td>
                          <td>
                            {waiting.length ? waiting.join(" · ") : "—"}
                            {waiting.length > 0 && (
                              <div className="muted-strong" style={{ fontSize: 11 }}>
                                fills {m.expectedWait}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted-strong" style={{ fontSize: 11, marginTop: 8 }}>
                Valued at the feed's latest price. Orders fill at the next new one.{" "}
                <button className="linklike" onClick={onOpenTrade} style={{ color: "var(--color-accent)" }}>
                  Open the Trade page →
                </button>
              </p>
            </>
          );
        })()
      )}
    </section>
  );
}
