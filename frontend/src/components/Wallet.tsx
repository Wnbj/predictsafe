import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useBaseBalances, useBridgeTransfers } from "../hooks/useBridge";
import { useExchange } from "../hooks/useExchange";
import { useNow } from "../hooks/useNow";
import { ASSET_IMAGES } from "../lib/categories";
import { ccipExplorerTx, CCIP_CHAINS, type CcipSide } from "../lib/ccip";
import { holdingsFor, marketState, valueOf, type ExchangeOrder, type ExchangeState, type OrderSide } from "../lib/exchange";
import { formatRelative, formatToken, shortAddress } from "../lib/format";
import { isPending, SLOW_AFTER_MS, type BridgeTransfer } from "../lib/transfers";
import { BridgeDialog, type BridgeAsset } from "./BridgeDialog";
import { TradeDialog } from "./TradeDialog";
import { ChainBadge, formatDollars, formatUnitsShort } from "./walletParts";

/**
 * The portfolio's wallet: what this address holds of the exchange's tokens
 * and mUSDC, on both chains, in dollars — and what it has done with them.
 *
 * Kept apart from the market positions below it, and out of their totals, on
 * purpose. A stake is a claim on a pot that settles once; a token is a claim
 * on a reserve at whatever the feed says next. Adding the two into one figure
 * would sum things that are not the same kind of money.
 *
 * Tokens in a CCIP transfer are counted in the total and shown as in transit:
 * burned on one chain and not yet minted on the other, they are on neither
 * balance, and a total that dipped for twenty minutes would read as a loss.
 */

/** About how long a transfer takes, for the progress bar. Measured 15 min Sepolia → Base. */
const EXPECTED_MS = 20 * 60_000;

type Tab = "assets" | "activity";

export function Wallet({ account, onOpenTrade }: { account: Address; onOpenTrade: () => void }) {
  const { state, error, usdc, now, reload } = useExchange(account);
  const base = useBaseBalances(account);
  const transfers = useBridgeTransfers(account, () => {
    void reload();
    void base.reload();
  });
  const clock = useNow(5_000);
  const [tab, setTab] = useState<Tab>("assets");
  const [bridge, setBridge] = useState<{ symbol: string; from: CcipSide } | null>(null);
  const [trade, setTrade] = useState<{ side: OrderSide; assetId: number } | null>(null);

  const inTransit = useMemo(() => {
    const m: Record<string, bigint> = {};
    for (const t of transfers) if (isPending(t)) m[t.symbol] = (m[t.symbol] ?? 0n) + BigInt(t.amount);
    return m;
  }, [transfers]);

  const assets: (BridgeAsset & { feedSymbol: string; value: bigint; transit: bigint })[] = useMemo(
    () =>
      (state?.assets ?? []).map((a) => {
        const symbol = `s${a.symbol}`;
        const onBase = base.balances?.[symbol] ?? null;
        const transit = inTransit[symbol] ?? 0n;
        return {
          symbol,
          feedSymbol: a.symbol,
          name: `Synthetic ${a.name}`,
          image: ASSET_IMAGES[a.symbol],
          price: a.latest.answer,
          feedDecimals: a.feedDecimals,
          sepolia: a.balance,
          base: onBase,
          transit,
          value: valueOf(a.balance + (onBase ?? 0n) + transit, a.latest.answer, a.feedDecimals),
        };
      }),
    [state, base.balances, inTransit],
  );

  const total = assets.reduce((s, a) => s + a.value, usdc.balance);
  const pendingTransfers = transfers.filter(isPending);
  const myOrders = useMemo(
    () => (state ? state.orders.filter((o) => o.trader.toLowerCase() === account.toLowerCase()) : []),
    [state, account],
  );
  const pendingOrders = myOrders.filter((o) => o.status === "pending").length;
  const waiting = state ? holdingsFor(state, account, true) : [];

  const openBridge = (symbol?: string) => {
    const a = assets.find((x) => x.symbol === symbol) ?? assets.find((x) => x.sepolia > 0n || (x.base ?? 0n) > 0n) ?? assets[0];
    if (!a) return;
    setBridge({ symbol: a.symbol, from: a.sepolia === 0n && (a.base ?? 0n) > 0n ? "base" : "sepolia" });
  };

  const openTrade = (side: OrderSide) => {
    if (!state || state.assets.length === 0) return;
    const held = side === "sell" ? state.assets.find((a) => a.balance > 0n) : undefined;
    setTrade({ side, assetId: (held ?? state.assets[0]!).id });
  };

  return (
    <section className="wallet" aria-label="Wallet">
      <div className="wallet-head">
        <div>
          <div className="eyebrow">Wallet · {shortAddress(account)}</div>
          <div className="wallet-total">{state ? formatDollars(total) : "…"}</div>
          <div className="wallet-sub">
            <ChainBadge side="sepolia" />
            <ChainBadge side="base" />
            {pendingTransfers.length > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                incl. {pendingTransfers.length} transfer{pendingTransfers.length === 1 ? "" : "s"} in transit
              </span>
            )}
          </div>
        </div>
        <div className="wallet-actions">
          <WalletAction icon="+" label="Buy" onClick={() => openTrade("buy")} disabled={!state} />
          <WalletAction icon="−" label="Sell" onClick={() => openTrade("sell")} disabled={!state} />
          <WalletAction icon="⇄" label="CCIP Transfer" onClick={() => openBridge()} disabled={!state} />
        </div>
      </div>

      {error && (
        <div style={{ color: "var(--color-negative)", fontSize: 13 }}>Could not read the exchange: {error}</div>
      )}

      {pendingTransfers.length > 0 && tab === "assets" && (
        <button className="wallet-transit" onClick={() => setTab("activity")}>
          <span className="spinner" aria-hidden="true" />
          {pendingTransfers.length === 1
            ? `${formatUnitsShort(BigInt(pendingTransfers[0]!.amount))} ${pendingTransfers[0]!.symbol} on its way to ${CCIP_CHAINS[pendingTransfers[0]!.to].name}`
            : `${pendingTransfers.length} transfers on their way`}
          <span className="muted" style={{ marginLeft: "auto" }}>View →</span>
        </button>
      )}

      <div className="wallet-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>
          Assets
        </button>
        <button role="tab" aria-selected={tab === "activity"} className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          Activity
          {pendingTransfers.length + pendingOrders > 0 && <span className="wallet-count">{pendingTransfers.length + pendingOrders}</span>}
        </button>
      </div>

      {!state ? (
        <ul className="wallet-list">
          {[0, 1, 2].map((i) => (
            <li key={i} className="wallet-row">
              <span className="wallet-icon skeleton" />
              <div className="skeleton" style={{ height: 14, width: "40%" }} />
            </li>
          ))}
        </ul>
      ) : tab === "assets" ? (
        <ul className="wallet-list">
          <li className="wallet-row">
            <span className="wallet-icon wallet-icon-usd" aria-hidden="true">$</span>
            <div className="wallet-row-main">
              <div className="wallet-row-name">
                Mock USDC <span className="muted-strong">mUSDC</span>
              </div>
              <div className="wallet-row-chains">
                <span className="muted">$1.00</span>
                <ChainAmount side="sepolia" text={formatToken(usdc.balance, { symbol: false })} />
              </div>
            </div>
            <div className="wallet-row-value">
              <div>{formatDollars(usdc.balance)}</div>
              <div className="muted">{formatToken(usdc.balance)}</div>
            </div>
            <span className="wallet-row-action" />
          </li>

          {assets.map((a) => {
            const asset = state.assets.find((x) => `s${x.symbol}` === a.symbol)!;
            const held = a.sepolia + (a.base ?? 0n) + a.transit;
            const w = waiting.find((h) => h.asset.id === asset.id);
            const orders = w
              ? [
                  w.pendingBuys > 0 && `${w.pendingBuys} buy${w.pendingBuys === 1 ? "" : "s"} · ${formatToken(w.pendingBuyUsdc)}`,
                  w.pendingSells > 0 && `${w.pendingSells} sell${w.pendingSells === 1 ? "" : "s"} · ${formatUnitsShort(w.pendingSellTokens)} ${a.symbol}`,
                ].filter(Boolean)
              : [];
            return (
              <li key={a.symbol} className={`wallet-row${held === 0n && orders.length === 0 ? " empty" : ""}`}>
                {a.image ? (
                  <img className="wallet-icon" src={a.image} alt="" />
                ) : (
                  <span className="wallet-icon" aria-hidden="true" />
                )}
                <div className="wallet-row-main">
                  <div className="wallet-row-name">
                    {a.name} <span className="muted-strong">{a.symbol}</span>
                  </div>
                  <div className="wallet-row-chains">
                    <span className="muted">{formatDollars(valueOf(10n ** 18n, a.price, a.feedDecimals))}</span>
                    <ChainAmount side="sepolia" text={formatUnitsShort(a.sepolia)} />
                    <ChainAmount side="base" text={a.base === null ? "…" : formatUnitsShort(a.base)} />
                    {a.transit > 0n && <span className="chain-amount transit">⇄ {formatUnitsShort(a.transit)} in transit</span>}
                  </div>
                  {orders.length > 0 && (
                    <div className="wallet-row-note muted">
                      {orders.join(" · ")} waiting — fills {marketState(asset, now).expectedWait}
                    </div>
                  )}
                </div>
                <div className="wallet-row-value">
                  <div>{formatDollars(a.value)}</div>
                  <div className="muted">
                    {formatUnitsShort(held)} {a.symbol}
                  </div>
                </div>
                <button
                  className="btn wallet-row-action"
                  disabled={a.sepolia === 0n && (a.base ?? 0n) === 0n}
                  onClick={() => openBridge(a.symbol)}
                  title={`Move ${a.symbol} between Sepolia and Base Sepolia with Chainlink CCIP`}
                >
                  ⇄ CCIP Transfer
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Activity transfers={transfers} orders={myOrders} state={state} clockSeconds={clock} />
      )}

      <p className="muted-strong" style={{ fontSize: 11, margin: 0 }}>
        Valued at each Chainlink feed's latest price. Orders fill at the next new one.{" "}
        <button className="linklike" onClick={onOpenTrade} style={{ color: "var(--color-accent)" }}>
          Full exchange page →
        </button>
      </p>

      {trade && state && (
        <TradeDialog
          account={account}
          state={state}
          usdc={usdc}
          now={now}
          initial={trade}
          baseBalances={base.balances}
          onClose={() => setTrade(null)}
          onDone={() => reload()}
          onTransferBack={(symbol) => {
            setTrade(null);
            setBridge({ symbol, from: "base" });
          }}
        />
      )}

      {bridge && state && (
        <BridgeDialog
          account={account}
          assets={assets}
          initial={bridge}
          onClose={() => setBridge(null)}
          onSent={() => {
            void reload();
            void base.reload();
          }}
        />
      )}
    </section>
  );
}

function WalletAction({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="wallet-action" onClick={onClick} disabled={disabled}>
      <span className="wallet-action-icon" aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

function ChainAmount({ side, text }: { side: CcipSide; text: string }) {
  return (
    <span className="chain-amount">
      <ChainBadge side={side} short /> {text}
    </span>
  );
}

type ActivityItem =
  | { kind: "transfer"; at: number; t: BridgeTransfer }
  | { kind: "order"; at: number; o: ExchangeOrder };

function Activity({
  transfers,
  orders,
  state,
  clockSeconds,
}: {
  transfers: BridgeTransfer[];
  orders: ExchangeOrder[];
  state: ExchangeState;
  clockSeconds: number;
}) {
  const items: ActivityItem[] = [
    ...transfers.map((t) => ({ kind: "transfer" as const, at: t.sentAt, t })),
    ...orders.map((o) => ({ kind: "order" as const, at: o.placedAt * 1000, o })),
  ].sort((a, b) => b.at - a.at);

  if (items.length === 0) {
    return <div className="muted" style={{ fontSize: 13, padding: "var(--space-4) 0" }}>Nothing yet — orders and transfers show up here.</div>;
  }

  const nowMs = clockSeconds * 1000;
  return (
    <ul className="wallet-list">
      {items.map((it) =>
        it.kind === "transfer" ? (
          <TransferRow key={it.t.hash} t={it.t} nowMs={nowMs} />
        ) : (
          <OrderRow key={`o${it.o.id}`} o={it.o} state={state} nowSeconds={clockSeconds} />
        ),
      )}
    </ul>
  );
}

function TransferRow({ t, nowMs }: { t: BridgeTransfer; nowMs: number }) {
  const pending = isPending(t);
  const elapsed = nowMs - t.sentAt;
  const slow = pending && elapsed > SLOW_AFTER_MS;
  const progress = Math.min(0.95, elapsed / EXPECTED_MS);
  return (
    <li className="wallet-row">
      <span className={`wallet-icon wallet-icon-glyph${pending ? " live" : ""}`} aria-hidden="true">⇄</span>
      <div className="wallet-row-main">
        <div className="wallet-row-name">
          Sent {formatUnitsShort(BigInt(t.amount))} {t.symbol} via CCIP
        </div>
        <div className="wallet-row-chains">
          <ChainBadge side={t.from} short /> <span className="muted">→</span> <ChainBadge side={t.to} short />
          <span className="muted">· {formatRelative(Math.floor(t.sentAt / 1000), Math.floor(nowMs / 1000))}</span>
        </div>
        {pending && (
          <div className="wallet-progress" aria-label="Transfer progress">
            <span style={{ width: `${(progress * 100).toFixed(0)}%` }} />
          </div>
        )}
      </div>
      <div className="wallet-row-value">
        <span className={`wallet-status ${pending ? (slow ? "slow" : "pending") : "done"}`}>
          {pending ? (slow ? "Taking longer" : "In transit") : "Arrived"}
        </span>
        <div className="muted" style={{ fontSize: 12 }}>
          {pending
            ? slow
              ? "Explorer has the detail"
              : `~${Math.max(1, Math.round((EXPECTED_MS - elapsed) / 60_000))} min left`
            : `in ${Math.max(1, Math.round((t.arrivedAt! - t.sentAt) / 60_000))} min`}
        </div>
      </div>
      <a className="btn wallet-row-action" href={ccipExplorerTx(t.hash)} target="_blank" rel="noreferrer" title="Open in CCIP Explorer">
        CCIP ↗
      </a>
    </li>
  );
}

function OrderRow({ o, state, nowSeconds }: { o: ExchangeOrder; state: ExchangeState; nowSeconds: number }) {
  const asset = state.assets.find((a) => a.id === o.assetId);
  const symbol = asset ? `s${asset.symbol}` : "?";
  const buy = o.side === "buy";
  const title =
    o.status === "filled"
      ? buy
        ? `Bought ${formatUnitsShort(o.amountOut)} ${symbol}`
        : `Sold ${formatUnitsShort(o.amountIn)} ${symbol}`
      : o.status === "refunded"
        ? `${buy ? "Buy" : "Sell"} order refunded`
        : buy
          ? `Buy ${symbol} with ${formatToken(o.amountIn)}`
          : `Sell ${formatUnitsShort(o.amountIn)} ${symbol}`;
  const detail =
    o.status === "filled"
      ? buy
        ? `for ${formatToken(o.amountIn)}`
        : `for ${formatToken(o.amountOut)}`
      : o.status === "pending" && asset
        ? `fills ${marketState(asset, nowSeconds).expectedWait}`
        : "";
  return (
    <li className="wallet-row">
      <span className="wallet-icon wallet-icon-glyph" aria-hidden="true">{buy ? "+" : "−"}</span>
      <div className="wallet-row-main">
        <div className="wallet-row-name">{title}</div>
        <div className="wallet-row-chains">
          <ChainBadge side="sepolia" short />
          <span className="muted">· {formatRelative(o.placedAt, nowSeconds)}</span>
          {detail && <span className="muted">· {detail}</span>}
        </div>
      </div>
      <div className="wallet-row-value">
        <span className={`wallet-status ${o.status === "pending" ? "pending" : o.status === "filled" ? "done" : "slow"}`}>
          {o.status === "pending" ? "Waiting" : o.status === "filled" ? "Filled" : "Refunded"}
        </span>
        <div className="muted" style={{ fontSize: 12 }}>Order #{o.id}</div>
      </div>
      <span className="wallet-row-action" />
    </li>
  );
}
