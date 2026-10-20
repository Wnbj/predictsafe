import { useMemo, useState } from "react";
import type { Address } from "viem";
import { category } from "../lib/categories";
import { formatRelative, formatSigned, formatToken } from "../lib/format";
import {
  sendAmmRedeem,
  sendAmmWithdrawLiquidity,
  sendClaim,
  waitForTx,
} from "../lib/chain";
import { useNow } from "../hooks/useNow";
import { Wallet } from "../components/Wallet";
import { isAmm, MarketStatus, type Market, type Position } from "../lib/types";
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
  marketsLoading = false,
}: {
  positions: Position[];
  wallet: WalletState;
  onOpenMarket: (key: string) => void;
  onRefresh: () => Promise<void>;
  onOpenTrade: () => void;
  /** The market positions are still loading; the token holdings are not gated on them. */
  marketsLoading?: boolean;
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
        isAmm(market)
          ? await sendAmmRedeem(wallet.account as Address, market)
          : await sendClaim(wallet.account as Address, market);
      await waitForTx(hash, isAmm(market) ? "Redeem" : "Claim");
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
      await waitForTx(hash, "Liquidity withdrawal");
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
            Connect a wallet to see the stakes and tokens it holds.
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

      {/*
        * First, not last: below the market table it sat under every position
        * this wallet ever took — 29 rows on the deployer — and read as missing.
        */}
      <Wallet account={wallet.account} onOpenTrade={onOpenTrade} />

      <PositionsSection
        positions={positions}
        loading={marketsLoading}
        totals={totals}
        filter={filter}
        setFilter={setFilter}
        filtered={filtered}
        error={error}
        claiming={claiming}
        onClaim={(m) => void doClaim(m)}
        onWithdraw={(m) => void doWithdraw(m)}
        onOpenMarket={onOpenMarket}
      />
    </div>
  );
}

/** How many rows show before "Show all". The deployer alone holds over seventy. */
const PAGE = 10;

const isResolved = (p: Position) =>
  p.market.status === MarketStatus.Settled || p.market.status === MarketStatus.Void;

/**
 * Money waiting first — it is the reason to open this page — then what is
 * still open, then history; newest first within each.
 */
function rank(p: Position): number {
  if (p.claimable > 0n) return 0;
  return isResolved(p) ? 2 : 1;
}

/**
 * The positions as a list in the wallet's style rather than a seven-column
 * table: one row per market with the question, the side and the stake under
 * it, the result on the right, and the one thing to do about it.
 */
function PositionsSection({
  positions,
  loading,
  totals,
  filter,
  setFilter,
  filtered,
  error,
  claiming,
  onClaim,
  onWithdraw,
  onOpenMarket,
}: {
  positions: Position[];
  loading: boolean;
  totals: { staked: bigint; claimable: bigint; realised: bigint; open: number };
  filter: Filter;
  setFilter: (f: Filter) => void;
  filtered: Position[];
  error: string | null;
  claiming: string | null;
  onClaim: (m: Market) => void;
  onWithdraw: (m: Market) => void;
  onOpenMarket: (key: string) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const now = useNow(30_000);

  const counts: Record<Filter, number> = {
    all: positions.length,
    open: positions.filter((p) => !isResolved(p)).length,
    resolved: positions.filter(isResolved).length,
    claimable: positions.filter((p) => p.claimable > 0n).length,
  };

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => rank(a) - rank(b) || b.market.closeTime - a.market.closeTime),
    [filtered],
  );

  const choose = (f: Filter) => {
    setFilter(f);
    setShown(PAGE);
  };

  return (
    <section className="wallet" aria-label="Prediction market positions">
      <div className="wallet-head">
        <div>
          <div className="eyebrow">Prediction markets</div>
          <div
            className="wallet-total"
            style={{
              color: loading ? undefined : totals.realised >= 0n ? "var(--color-accent-300)" : "var(--color-negative)",
            }}
          >
            {loading ? "…" : formatSigned(totals.realised)}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            realised P&amp;L on resolved markets
          </div>
        </div>
        <div className="positions-stats">
          <div>
            <span>Staked</span>
            <b>{loading ? "…" : formatToken(totals.staked)}</b>
          </div>
          <div className={totals.claimable > 0n ? "accent" : undefined}>
            <span>To collect</span>
            <b>{loading ? "…" : formatToken(totals.claimable)}</b>
          </div>
          <div>
            <span>Open</span>
            <b>{loading ? "…" : totals.open}</b>
          </div>
        </div>
      </div>

      {!loading && totals.claimable > 0n && filter !== "claimable" && (
        <button className="wallet-transit" onClick={() => choose("claimable")}>
          <span className="positions-coin" aria-hidden="true">$</span>
          {formatToken(totals.claimable)} waiting to be collected from {counts.claimable} market
          {counts.claimable === 1 ? "" : "s"}
          <span className="muted" style={{ marginLeft: "auto" }}>Show →</span>
        </button>
      )}

      <div className="wallet-tabs" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={filter === f.key ? "active" : ""}
            onClick={() => choose(f.key)}
          >
            {f.label}
            {!loading &&
              (f.key === "claimable" ? (
                counts.claimable > 0 && <span className="wallet-count">{counts.claimable}</span>
              ) : (
                <span className="muted-strong" style={{ fontSize: 12 }}>{counts[f.key]}</span>
              ))}
          </button>
        ))}
      </div>

      {error && <div style={{ color: "var(--color-negative)", fontSize: 13 }}>{error}</div>}

      {loading ? (
        <ul className="wallet-list">
          {[0, 1, 2].map((i) => (
            <li key={i} className="wallet-row">
              <span className="wallet-icon skeleton" />
              <div className="skeleton" style={{ height: 14, width: "50%" }} />
            </li>
          ))}
        </ul>
      ) : sorted.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, padding: "var(--space-4) 0" }}>
          {positions.length === 0 ? "This wallet has not staked on any market yet." : "No positions match this filter."}
        </div>
      ) : (
        <>
          <ul className="wallet-list">
            {sorted.slice(0, shown).map((p) => (
              <PositionRow
                key={p.market.key}
                p={p}
                now={now}
                claiming={claiming}
                onClaim={onClaim}
                onWithdraw={onWithdraw}
                onOpenMarket={onOpenMarket}
              />
            ))}
          </ul>
          {sorted.length > shown && (
            <button className="btn positions-more" onClick={() => setShown(sorted.length)}>
              Show all {sorted.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const STATUS_CLASS: Record<Position["status"], string> = {
  Open: "pending",
  "Awaiting settlement": "pending",
  Won: "done",
  Lost: "lost",
  Refundable: "slow",
  Claimed: "neutral",
};

function PositionRow({
  p,
  now,
  claiming,
  onClaim,
  onWithdraw,
  onOpenMarket,
}: {
  p: Position;
  now: number;
  claiming: string | null;
  onClaim: (m: Market) => void;
  onWithdraw: (m: Market) => void;
  onOpenMarket: (key: string) => void;
}) {
  const cat = category(p.market.categoryId);
  /**
   * `p.cost`, matching the totals above. This row once used `p.yes + p.no`,
   * which for an AMM is SHARES rather than money — so the list disagreed with
   * its own totals, and the disagreement grew with every liquidity position.
   */
  const size = p.cost;
  const resolved = isResolved(p);
  const pl = resolved ? p.entitlement - size : null;
  // What `redeem`/`claim` alone would pay: the pool slice is a separate call
  // and must not gate this button.
  const shareClaim = p.shareClaimable;
  const amm = isAmm(p.market);
  const side = p.lp
    ? p.yes > 0n || p.no > 0n
      ? `LP + ${p.yes > 0n ? "Yes" : "No"}`
      : "LP"
    : p.yes > 0n && p.no > 0n
      ? "Both"
      : p.yes > 0n
        ? "Yes"
        : "No";
  const canWithdraw = resolved && p.lp && !p.lp.withdrawn && p.lp.poolValue > 0n;
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    onOpenMarket(p.market.key);
  };

  return (
    <li className={`wallet-row position-row${p.claimable > 0n ? " claimable" : ""}`}>
      {cat.image ? (
        <img className="wallet-icon" src={cat.image} alt="" />
      ) : (
        <span className="wallet-icon wallet-icon-glyph" aria-hidden="true">{cat.icon(26)}</span>
      )}
      <div className="wallet-row-main">
        <a href="#" className="wallet-row-name position-question" onClick={open}>
          {p.market.question}
        </a>
        <div className="wallet-row-chains">
          <span className="muted">{cat.name}</span>
          <span className={`position-side ${side === "No" ? "no" : "yes"}`}>{side}</span>
          <span className="muted">{formatToken(size)} in</span>
          {!resolved && p.market.closeTime > 0 && (
            <span className="muted">
              {p.market.closeTime > now ? `closes ${formatRelative(p.market.closeTime, now)}` : "closed, settling"}
            </span>
          )}
        </div>
      </div>
      <div className="wallet-row-value">
        <div
          style={{
            color: pl === null ? undefined : pl > 0n ? "var(--color-accent-300)" : pl < 0n ? "var(--color-negative)" : undefined,
          }}
        >
          {pl === null ? formatToken(size) : formatSigned(pl)}
        </div>
        <span className={`wallet-status ${STATUS_CLASS[p.status]}`}>
          {p.status === "Awaiting settlement" ? "Settling" : p.status}
        </span>
      </div>
      {/*
        * TWO claims, two buttons. A provider is owed their shares through
        * `redeem` and their slice of the pool through `withdrawLiquidity`, each
        * with its own irreversible one-shot guard on chain. A single button
        * would fire one and strand the other for good.
        */}
      <div className="wallet-row-action position-actions">
        {shareClaim > 0n && (
          <button className="btn btn-accent" disabled={claiming !== null} onClick={() => onClaim(p.market)}>
            {claiming === p.market.key
              ? amm
                ? "Redeeming…"
                : "Claiming…"
              : `${amm ? "Redeem" : "Claim"} ${formatToken(shareClaim)}`}
          </button>
        )}
        {canWithdraw && (
          <button className="btn" disabled={claiming !== null} onClick={() => onWithdraw(p.market)}>
            {claiming === `${p.market.key}:lp` ? "Withdrawing…" : "Withdraw LP"}
          </button>
        )}
        {shareClaim === 0n && !canWithdraw && (
          <a href="#" className="btn position-view" onClick={open}>
            View
          </a>
        )}
      </div>
    </li>
  );
}
