import { useMemo, useState } from "react";
import type { Address } from "viem";
import { category } from "../lib/categories";
import { formatSigned, formatToken } from "../lib/format";
import {
  sendAmmRedeem,
  sendAmmWithdrawLiquidity,
  sendClaim,
  waitForTx,
} from "../lib/chain";
import { SummaryCard } from "../components/SummaryCard";
import { TokenizedHoldings } from "../components/TokenizedHoldings";
import { MarketStatus, type Market, type Position } from "../lib/types";
import type { WalletState } from "../hooks/useWallet";

type Filter = "all" | "open" | "resolved" | "claimable";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "claimable", label: "Claimable" },
];

export function Portfolio({
  positions,
  wallet,
  onOpenMarket,
  onRefresh,
  onOpenTrade,
}: {
  positions: Position[];
  wallet: WalletState;
  onOpenMarket: (key: string) => void;
  onRefresh: () => Promise<void>;
  onOpenTrade: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    let staked = 0n;
    let claimable = 0n;
    let realised = 0n;
    let open = 0;

    for (const p of positions) {
      // Cost, not position size: for an AMM they are different quantities in
      // different units, and a sale returns part of the cost.
      const size = p.cost;
      staked += size;
      claimable += p.claimable;
      const resolved =
        p.market.status === MarketStatus.Settled || p.market.status === MarketStatus.Void;
      if (resolved) {
        // Measured against the entitlement, not what is still claimable —
        // otherwise claiming a win would erase it from the total.
        realised += p.entitlement - size;
      } else {
        open += 1;
      }
    }
    return { staked, claimable, realised, open };
  }, [positions]);

  const filtered = useMemo(() => {
    if (filter === "all") return positions;
    /*
     * `claimable` already answers both halves of the question — it is zero
     * once the shares are redeemed AND the pool is withdrawn, and non-zero
     * while either is outstanding. Adding `!p.claimed` on top gated the whole
     * row on the SHARES flag, so redeeming first hid a pool claim that was
     * still sitting there, on the one screen whose job is to find it.
     */
    if (filter === "claimable") return positions.filter((p) => p.claimable > 0n);
    if (filter === "open")
      return positions.filter(
        (p) =>
          p.market.status !== MarketStatus.Settled && p.market.status !== MarketStatus.Void,
      );
    return positions.filter(
      (p) => p.market.status === MarketStatus.Settled || p.market.status === MarketStatus.Void,
    );
  }, [positions, filter]);

  const doClaim = async (market: Market) => {
    if (!wallet.account) return;
    setClaiming(market.key);
    setError(null);
    try {
      // AmmMarket has no claim() at all — it has redeem(). Calling the wrong
      // one does not fail loudly, it simply reverts on a selector the contract
      // has never heard of.
      const hash =
        market.categoryId === "amm"
          ? await sendAmmRedeem(wallet.account as Address, market)
          : await sendClaim(wallet.account as Address, market);
      await waitForTx(hash);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/User rejected/i.test(msg) ? "Transaction rejected in wallet." : msg.split("\n")[0]);
    } finally {
      setClaiming(null);
    }
  };

  const doWithdraw = async (market: Market) => {
    if (!wallet.account) return;
    setClaiming(`${market.key}:lp`);
    setError(null);
    try {
      const hash = await sendAmmWithdrawLiquidity(wallet.account as Address, market);
      await waitForTx(hash);
      await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/User rejected/i.test(msg) ? "Transaction rejected in wallet." : msg.split("\n")[0]);
    } finally {
      setClaiming(null);
    }
  };

  if (!wallet.account) {
    return (
      <div className="page">
        <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
          My positions
        </h2>
        <div className="card" style={{ maxWidth: 480, marginTop: "var(--space-4)" }}>
          <div className="heading" style={{ fontSize: 17 }}>
            Wallet not connected
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Connect a wallet to see the stakes it holds.
          </div>
          <button className="btn btn-accent" onClick={() => void wallet.connect()}>
            Connect wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        My positions
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)" }}>
        {positions.length} position{positions.length === 1 ? "" : "s"} · {totals.open} open
      </p>

      <div className="grid-4" style={{ maxWidth: 1100, marginBottom: "var(--space-6)" }}>
        <SummaryCard label="Total staked" value={formatToken(totals.staked)} />
        <SummaryCard
          label="Claimable now"
          value={formatToken(totals.claimable)}
          accent={totals.claimable > 0n}
        />
        <SummaryCard
          label="Realised P&L"
          value={formatSigned(totals.realised)}
          color={totals.realised >= 0n ? "var(--color-accent-300)" : "var(--color-negative)"}
        />
        <SummaryCard label="Open positions" value={String(totals.open)} />
      </div>

      <div className="seg" style={{ marginBottom: "var(--space-4)" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "active" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ color: "var(--color-negative)", fontSize: 13, marginBottom: "var(--space-3)" }}>
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="heading" style={{ fontSize: 17 }}>
            Nothing to show
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {positions.length === 0
              ? "This wallet has not staked on any market yet."
              : "No positions match this filter."}
          </div>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data" style={{ maxWidth: 1200 }}>
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Staked</th>
                <th>Claimable</th>
                <th>P&amp;L</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const cat = category(p.market.categoryId);
                /**
                 * `p.cost`, matching the summary cards above. This row used to
                 * use `p.yes + p.no`, which for an AMM is SHARES rather than
                 * money — so the table disagreed with its own totals, and the
                 * disagreement grew with every liquidity position.
                 */
                const size = p.cost;
                const resolved =
                  p.market.status === MarketStatus.Settled ||
                  p.market.status === MarketStatus.Void;
                const pl = resolved ? p.entitlement - size : null;
                // What `redeem`/`claim` alone would pay: the pool slice is a
                // separate call and must not gate this button. This row had
                // the rule right before `shareClaimable` existed and derived
                // it by hand; the field now says it once, for every caller.
                const shareClaim = p.shareClaimable;
                const side = p.lp
                  ? p.yes > 0n || p.no > 0n
                    ? `LP + ${p.yes > 0n ? "Yes" : "No"}`
                    : "LP"
                  : p.yes > 0n && p.no > 0n
                    ? "Both"
                    : p.yes > 0n
                      ? "Yes"
                      : "No";

                return (
                  <tr key={p.market.key}>
                    <td>
                      <span
                        className="tag"
                        style={{ ...cat.tagStyle, marginRight: 8 }}
                      >
                        {cat.name}
                      </span>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenMarket(p.market.key);
                        }}
                        style={{ textDecoration: "none" }}
                      >
                        {p.market.question}
                      </a>
                    </td>
                    <td>{side}</td>
                    <td>{formatToken(size)}</td>
                    <td>{p.claimable > 0n ? formatToken(p.claimable) : "—"}</td>
                    <td
                      style={{
                        color:
                          pl === null
                            ? undefined
                            : pl >= 0n
                              ? "var(--color-accent-300)"
                              : "var(--color-negative)",
                      }}
                    >
                      {pl === null ? "—" : formatSigned(pl)}
                    </td>
                    <td>
                      <span className="tag" style={statusStyle(p.status)}>
                        {p.status}
                      </span>
                    </td>
                    {/*
                      * TWO claims, two buttons. A provider is owed their shares
                      * through `redeem` and their slice of the pool through
                      * `withdrawLiquidity`, each with its own irreversible
                      * one-shot guard on chain. A single button would fire one
                      * and strand the other for good.
                      */}
                    <td style={{ display: "flex", gap: 6 }}>
                      {shareClaim > 0n && (
                        <button
                          className="btn btn-accent"
                          style={{ padding: "4px 10px", fontSize: 13 }}
                          disabled={claiming !== null}
                          onClick={() => void doClaim(p.market)}
                        >
                          {claiming === p.market.key
                            ? p.market.categoryId === "amm"
                              ? "Redeeming…"
                              : "Claiming…"
                            : p.market.categoryId === "amm"
                              ? "Redeem"
                              : "Claim"}
                        </button>
                      )}
                      {resolved && p.lp && !p.lp.withdrawn && p.lp.poolValue > 0n && (
                        <button
                          className="btn"
                          style={{ padding: "4px 10px", fontSize: 13 }}
                          disabled={claiming !== null}
                          onClick={() => void doWithdraw(p.market)}
                        >
                          {claiming === `${p.market.key}:lp` ? "Withdrawing…" : "Withdraw LP"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {wallet.account && <TokenizedHoldings account={wallet.account} onOpenTrade={onOpenTrade} />}
    </div>
  );
}

function statusStyle(status: Position["status"]): React.CSSProperties {
  switch (status) {
    case "Won":
      return { background: "#423a6a", color: "#f5f4ff" };
    case "Lost":
      return { background: "#3f424d", color: "#f3f5fe" };
    case "Refundable":
      return { background: "#423e5d", color: "#f5f4ff" };
    case "Claimed":
      return { background: "#292b31", color: "#b2b6ca" };
    default:
      return {
        background: "transparent",
        border: "1px solid var(--color-accent)",
        color: "var(--color-accent)",
      };
  }
}
