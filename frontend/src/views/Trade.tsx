import { useMemo, useState } from "react";
import type { Address } from "viem";
import { txLabel } from "../lib/toasts";
import { ASSET_IMAGES } from "../lib/categories";
import { EXCHANGE_ADDRESS, RESERVE_ATTESTATION_ADDRESS, addressUrl } from "../lib/config";
import { formatClock, formatRelative, formatToken, shortAddress } from "../lib/format";
import { waitForTx } from "../lib/chain";
import {
  canCancel,
  exchangeError,
  formatFeedPrice,
  marketState,
  sendCancel,
  sendFill,
  valueOf,
  type ExchangeAsset,
  type ExchangeOrder,
  type ExchangeState,
  type OrderSide,
} from "../lib/exchange";
import type { WalletState } from "../hooks/useWallet";
import { useExchange } from "../hooks/useExchange";
import { useBaseBalances, useBaseSupply } from "../hooks/useBridge";
import { BANDS, hourCells, nextAttestation, useReserveAttestation } from "../hooks/useReserveAttestation";
import { TradeForm } from "../components/TradeForm";
import { BridgeDialog, type BridgeAsset } from "../components/BridgeDialog";
import { formatDollars, formatUnitsShort } from "../components/walletParts";

/**
 * The exchange page: synthetic gold and S&P 500, priced by Chainlink Data Feeds.
 *
 * Laid out like the portfolio's wallet: the assets as a list, the order form
 * beside it (the same TradeForm the wallet's Buy and Sell dialog uses), then
 * the orders and the reserve, each in a card of the same kind.
 *
 * It loads on its own rather than behind the markets read, because nothing
 * here depends on a market. Loading and polling live in `useExchange`, shared
 * with the portfolio.
 */
export function Trade({ wallet, onBalanceChange }: { wallet: WalletState; onBalanceChange: () => void }) {
  const account = wallet.account as Address | null;
  const { state, error, usdc, now, reload } = useExchange(account);
  const base = useBaseBalances(account);
  const [side, setSide] = useState<OrderSide>("buy");
  const [assetId, setAssetId] = useState(0);
  const [bridgeSymbol, setBridgeSymbol] = useState<string | null>(null);

  const refresh = async () => {
    await reload();
    onBalanceChange();
  };

  const pick = (id: number, s?: OrderSide) => {
    setAssetId(id);
    if (s) setSide(s);
    // On a phone the form sits below the list; take the reader to it.
    if (s && window.matchMedia("(max-width: 1100px)").matches) {
      document.getElementById("order-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Trade tokenized assets
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)", maxWidth: 780 }}>
        Synthetic gold and S&amp;P 500 ETF (CSPX) tokens, priced by Chainlink Data Feeds. Every order fills at
        the <b>next new price</b> the feed publishes — never at a price anyone already knows, which
        is what stops a trader who watches the real market from draining the reserve.
      </p>

      {error && (
        <div style={{ color: "var(--color-negative)", fontSize: 13, marginBottom: "var(--space-4)" }}>
          Could not read the exchange: {error}
        </div>
      )}

      <div className="trade-layout">
        <div className="trade-main">
          <section className="wallet" aria-label="Assets">
            <div className="eyebrow">Assets · priced by Chainlink Data Feeds</div>
            {!state ? (
              <ul className="wallet-list">
                {[0, 1].map((i) => (
                  <li key={i} className="wallet-row">
                    <span className="wallet-icon skeleton" />
                    <div className="skeleton" style={{ height: 14, width: "45%" }} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="wallet-list">
                {state.assets.map((a) => (
                  <AssetRow
                    key={a.id}
                    asset={a}
                    now={now}
                    held={account ? a.balance + (base.balances?.[`s${a.symbol}`] ?? 0n) : null}
                    selected={a.id === assetId}
                    onPick={(s) => pick(a.id, s)}
                  />
                ))}
              </ul>
            )}
          </section>

          <OffChainBacking />

          <HowItWorks />

          {state && <Orders state={state} account={account} now={now} onDone={refresh} />}
          {state && <Reserve state={state} />}
        </div>

        <aside className="wallet trade-side" id="order-form" aria-label="Place an order">
          {!account ? (
            <>
              <div className="heading" style={{ fontSize: 18 }}>Place an order</div>
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                Connect a wallet on Sepolia to buy or sell. Prices and orders are readable without one.
              </p>
              <button className="btn btn-accent bridge-submit" onClick={() => void wallet.connect()}>
                Connect wallet
              </button>
            </>
          ) : !state ? (
            <div className="muted" style={{ fontSize: 13 }}>Loading the exchange from Sepolia…</div>
          ) : (
            <TradeForm
              account={account}
              state={state}
              usdc={usdc}
              now={now}
              side={side}
              onSide={setSide}
              assetId={assetId}
              onAssetId={setAssetId}
              baseBalances={base.balances}
              onFinish={() => {}}
              onDone={refresh}
              onTransferBack={setBridgeSymbol}
            />
          )}
        </aside>
      </div>

      {bridgeSymbol && account && state && (
        <BridgeDialog
          account={account}
          assets={state.assets.map(
            (a): BridgeAsset => ({
              symbol: `s${a.symbol}`,
              name: `Synthetic ${a.name}`,
              image: ASSET_IMAGES[a.symbol],
              price: a.latest.answer,
              feedDecimals: a.feedDecimals,
              sepolia: a.balance,
              base: base.balances?.[`s${a.symbol}`] ?? null,
            }),
          )}
          initial={{ symbol: bridgeSymbol, from: "base" }}
          onClose={() => setBridgeSymbol(null)}
          onSent={() => {
            void refresh();
            void base.reload();
          }}
        />
      )}
    </div>
  );
}

/** One asset: its price and whether it is moving, what the wallet holds, and the two ways in. */
function AssetRow({
  asset,
  now,
  held,
  selected,
  onPick,
}: {
  asset: ExchangeAsset;
  now: number;
  /** On both chains; null when no wallet is connected. */
  held: bigint | null;
  selected: boolean;
  onPick: (side?: OrderSide) => void;
}) {
  const m = marketState(asset, now);
  const price = asset.latest.answer;
  const heldText =
    held === null
      ? null
      : held > 0n
        ? `you hold ${formatUnitsShort(held)} · ${formatDollars(valueOf(held, price, asset.feedDecimals))}`
        : "none held";
  return (
    <li className={`wallet-row trade-asset${selected ? " selected" : ""}`} onClick={() => onPick()}>
      {ASSET_IMAGES[asset.symbol] ? (
        <img className="wallet-icon" src={ASSET_IMAGES[asset.symbol]} alt="" />
      ) : (
        <span className="wallet-icon" aria-hidden="true" />
      )}
      <div className="wallet-row-main">
        <div className="wallet-row-name">
          Synthetic {asset.name} <span className="muted-strong">s{asset.symbol}</span>
        </div>
        <div className="wallet-row-chains">
          <span className={`feed-state ${m.state}`}>
            <span className="feed-dot" /> {m.label}
          </span>
          <span className="muted">updated {formatRelative(asset.latest.updatedAt, now)}</span>
        </div>
        <div className="wallet-row-note muted">
          New orders fill {m.expectedWait}
          {/* On a phone the holding moves here: beside the price it squeezed the name. */}
          {heldText && <span className="trade-held-narrow"> · {heldText}</span>}
        </div>
      </div>
      <div className="wallet-row-value">
        <div className="trade-price">{formatFeedPrice(price, asset.feedDecimals)}</div>
        {heldText && <div className="muted trade-held-wide">{heldText}</div>}
      </div>
      <div className="wallet-row-action position-actions trade-asset-actions">
        <button
          className="btn btn-accent"
          onClick={(e) => {
            e.stopPropagation();
            onPick("buy");
          }}
        >
          Buy
        </button>
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            onPick("sell");
          }}
        >
          Sell
        </button>
      </div>
    </li>
  );
}

function HowItWorks() {
  const steps = [
    ["Place an order", "Your mUSDC — or, for a sale, your tokens — is held by the contract."],
    ["Wait for a new price", "Gold: about hourly on weekdays. S&P 500 ETF: about daily. Weekends: none."],
    ["Filled automatically", "Chainlink CRE fills it on a schedule. Anyone can too — at the same price."],
  ];
  return (
    <section className="wallet" aria-label="How it works">
      <div className="eyebrow">How an order fills</div>
      <ol className="trade-steps">
        {steps.map(([title, text], i) => (
          <li key={title}>
            <span className="trade-step-n" aria-hidden="true">{i + 1}</span>
            <div>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>{title}</div>
              <div className="muted" style={{ fontSize: 13 }}>{text}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Busy = null | `fill-${number}` | `cancel-${number}`;
type OrdersTab = "mine" | "all";
const PAGE = 10;

function Orders({
  state,
  account,
  now,
  onDone,
}: {
  state: ExchangeState;
  account: Address | null;
  now: number;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const mine = useMemo(
    () => (account ? state.orders.filter((o) => o.trader.toLowerCase() === account.toLowerCase()) : []),
    [state.orders, account],
  );
  // Your own orders when you have some; otherwise everyone's, so the page
  // shows the mechanism working before anyone signs in.
  const [tab, setTab] = useState<OrdersTab | null>(null);
  const active: OrdersTab = tab ?? (mine.length ? "mine" : "all");
  const list = (active === "mine" ? mine : state.orders).slice().reverse();

  const act = async (label: Busy, fn: (a: Address) => Promise<`0x${string}`>) => {
    if (!account) return;
    setBusy(label);
    setError(null);
    try {
      await waitForTx(await fn(account), txLabel(label));
      await onDone();
    } catch (e) {
      setError(exchangeError(e));
    } finally {
      setBusy(null);
    }
  };

  const choose = (t: OrdersTab) => {
    setTab(t);
    setShown(PAGE);
  };

  return (
    <section className="wallet" aria-label="Orders">
      <div className="eyebrow">Orders</div>
      <div className="wallet-tabs" role="tablist">
        {account && (
          <button role="tab" aria-selected={active === "mine"} className={active === "mine" ? "active" : ""} onClick={() => choose("mine")}>
            Your orders <span className="muted-strong" style={{ fontSize: 12 }}>{mine.length}</span>
          </button>
        )}
        <button role="tab" aria-selected={active === "all"} className={active === "all" ? "active" : ""} onClick={() => choose("all")}>
          Everyone <span className="muted-strong" style={{ fontSize: 12 }}>{state.orders.length}</span>
        </button>
      </div>

      {list.length === 0 ? (
        <div className="muted" style={{ fontSize: 13, padding: "var(--space-4) 0" }}>No orders yet.</div>
      ) : (
        <>
          <ul className="wallet-list">
            {list.slice(0, shown).map((o) => (
              <OrderRow
                key={o.id}
                o={o}
                asset={state.assets.find((a) => a.id === o.assetId)}
                account={account}
                showTrader={active === "all"}
                now={now}
                busy={busy}
                onFill={() => void act(`fill-${o.id}`, (a) => sendFill(a, [o.id]))}
                onCancel={() => void act(`cancel-${o.id}`, (a) => sendCancel(a, o.id))}
              />
            ))}
          </ul>
          {list.length > shown && (
            <button className="btn positions-more" onClick={() => setShown((n) => n + PAGE * 2)}>
              Show more ({list.length - shown})
            </button>
          )}
        </>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--color-negative)" }}>{error}</div>}
      <p className="muted-strong" style={{ fontSize: 11, margin: 0 }}>
        “Fill now” is open to anyone: the contract finds the price itself, so filling early or late
        changes nothing.{" "}
        <a href={addressUrl(EXCHANGE_ADDRESS)} target="_blank" rel="noreferrer">
          Contract {shortAddress(EXCHANGE_ADDRESS)} ↗
        </a>
      </p>
    </section>
  );
}

function OrderRow({
  o,
  asset,
  account,
  showTrader,
  now,
  busy,
  onFill,
  onCancel,
}: {
  o: ExchangeOrder;
  asset: ExchangeAsset | undefined;
  account: Address | null;
  showTrader: boolean;
  now: number;
  busy: Busy;
  onFill: () => void;
  onCancel: () => void;
}) {
  const symbol = asset ? `s${asset.symbol}` : "?";
  const dec = asset?.feedDecimals ?? 8;
  const buy = o.side === "buy";
  const title =
    o.status === "filled"
      ? buy
        ? `Bought ${formatUnitsShort(o.amountOut)} ${symbol}`
        : `Sold ${formatUnitsShort(o.amountIn)} ${symbol}`
      : o.status === "refunded"
        ? `${buy ? "Buy" : "Sell"} ${symbol} refunded`
        : buy
          ? `Buy ${symbol} with ${formatToken(o.amountIn)}`
          : `Sell ${formatUnitsShort(o.amountIn)} ${symbol}`;
  const price =
    o.status === "filled" ? formatFeedPrice(o.fillPrice, dec) : o.ready ? formatFeedPrice(o.ready.price, dec) : null;
  const status =
    o.status === "filled"
      ? { cls: "done", text: "Filled" }
      : o.status === "refunded"
        ? { cls: "slow", text: "Refunded" }
        : o.ready
          ? { cls: "pending", text: "Ready to fill" }
          : { cls: "pending", text: "Waiting" };
  const fillable = o.status === "pending" && o.ready && account;
  const cancellable = canCancel(o, account, now);

  return (
    <li className="wallet-row position-row">
      <span className="wallet-icon wallet-icon-glyph" aria-hidden="true">{buy ? "+" : "−"}</span>
      <div className="wallet-row-main">
        <div className="wallet-row-name">{title}</div>
        <div className="wallet-row-chains">
          <span className="muted">#{o.id}</span>
          {showTrader && <span className="muted">{shortAddress(o.trader)}</span>}
          <span className="muted">placed {formatRelative(o.placedAt, now)}</span>
          {o.status === "filled" && <span className="muted">for {buy ? formatToken(o.amountIn) : formatToken(o.amountOut)}</span>}
        </div>
      </div>
      <div className="wallet-row-value">
        {price && <div>{price}</div>}
        <span className={`wallet-status ${status.cls}`}>{status.text}</span>
      </div>
      <div className="wallet-row-action position-actions">
        {fillable && (
          <button className="btn btn-accent" disabled={busy !== null} onClick={onFill}>
            {busy === `fill-${o.id}` ? "Filling…" : "Fill now"}
          </button>
        )}
        {cancellable && (
          <button className="btn" disabled={busy !== null} onClick={onCancel}>
            {busy === `cancel-${o.id}` ? "Taking back…" : "Take back"}
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The reserve, and how much of the outstanding tokens it could pay today.
 *
 * Shown because it is the honest answer to "who pays me when gold goes up?":
 * this contract does, from a reserve, and a sale larger than the reserve is
 * refunded rather than paid in part.
 */
function Reserve({ state }: { state: ExchangeState }) {
  // Both chains: a token moved to Base Sepolia is burned here and minted
  // there, and it is still a claim on this reserve.
  const baseSupply = useBaseSupply();
  const outstanding = baseSupply
    ? state.assets.reduce(
        (sum, a) =>
          sum + valueOf(a.totalSupply + (baseSupply[`s${a.symbol}`] ?? 0n), a.latest.answer, a.feedDecimals),
        0n,
      )
    : null;
  const coverage =
    outstanding === null ? null : outstanding > 0n ? Number((state.reserve * 1000n) / outstanding) / 10 : null;
  return (
    <section className="wallet" aria-label="The reserve">
      <div className="wallet-head">
        <div>
          <div className="eyebrow">The reserve</div>
          <div className="wallet-total">{formatToken(state.reserve)}</div>
          <div className="muted" style={{ fontSize: 12 }}>available to pay sellers</div>
        </div>
        <div className="positions-stats">
          <div>
            <span>Tokens out</span>
            <b>{outstanding === null ? "…" : formatToken(outstanding)}</b>
          </div>
          <div className={coverage !== null && coverage >= 100 ? "accent" : undefined}>
            <span>Coverage</span>
            <b>{coverage === null ? "—" : `${coverage.toLocaleString()}%`}</b>
          </div>
          <div>
            <span>Held for buys</span>
            <b>{formatToken(state.escrowed)}</b>
          </div>
        </div>
      </div>
      <p className="muted-strong" style={{ fontSize: 11, margin: 0, maxWidth: 780 }}>
        This contract is the counterparty. When an asset rises, sellers are paid from the reserve;
        a sale the reserve cannot cover is refunded — the tokens come back — rather than paid in
        part. Buy orders still waiting are held apart and never used to pay anyone else. “Tokens
        out” counts both chains, at the latest prices: a token moved to Base Sepolia is still a
        claim on this reserve.
      </p>
    </section>
  );
}

/**
 * The second, off-chain answer to "is this backed?" — from a custodian's
 * account, read by a Chainlink CONFIDENTIAL workflow inside a TEE. What
 * reaches the chain, and this page, is a band; the balance stays in the
 * enclave, and no one running a node ever sees it.
 *
 * Its own section, high on the page: it is the claim the whole tokenized
 * side rests on, and it used to sit as a footnote under the reserve.
 */
function OffChainBacking() {
  const att = useReserveAttestation();
  const now = Math.floor(Date.now() / 1000);
  const next = nextAttestation(now);
  const band = att ? BANDS[att.band] : null;
  const cells = hourCells(att?.history ?? [], now);
  const due = cells.filter((c) => c.state === "attested" || c.state === "missed").length;
  const done = cells.filter((c) => c.state === "attested").length;
  const tone = !att ? "neutral" : att.band === 0 ? "short" : "covered";

  return (
    <section className={`wallet proof proof-${tone}`} aria-label="Proof of off-chain backing">
      <div className="proof-top">
        <div className="eyebrow">Proof of reserve · Chainlink confidential workflow</div>
        <span className="proof-live">
          <span className="proof-dot" aria-hidden="true" />
          Checked every hour · next {formatClock(next)} ({formatRelative(next, now)})
        </span>
      </div>

      <div className="proof-main">
        <svg className="proof-shield" viewBox="0 0 48 56" aria-hidden="true">
          <path d="M24 2 4 10v16c0 13 8.6 23.4 20 28 11.4-4.6 20-15 20-28V10L24 2Z" />
          {tone === "covered" ? (
            <path className="proof-shield-mark" d="m15 28 6.5 6.5L33.5 22" />
          ) : (
            <path className="proof-shield-mark" d="M24 18v14M24 38v.5" />
          )}
        </svg>
        <div>
          <div className="proof-band">
            {att === undefined ? "…" : att === null ? "Not attested yet" : att.band === 0 ? "Below 100%" : `≥ ${band!.short}`}
          </div>
          <div className="proof-says">
            {band ? band.says : "The custodian's account has not been checked yet."}
          </div>
        </div>
      </div>

      <div className="proof-meter" role="img" aria-label={band ? `Coverage band: ${band.label}` : "No coverage band yet"}>
        {BANDS.map((b, i) => (
          <div
            key={b.short}
            className={`proof-step${att && (i === 0 ? att.band === 0 : i <= att.band) ? " on" : ""}${att?.band === i ? " here" : ""}`}
          >
            <span className="proof-step-bar" />
            <span className="proof-step-label">{i === BANDS.length - 1 ? "500%+" : b.short}</span>
          </div>
        ))}
      </div>

      <div className="positions-stats">
        <div>
          <span>Tokens backed</span>
          <b>{att ? formatToken(att.obligations) : "—"}</b>
        </div>
        <div>
          <span>Last check</span>
          <b>{att ? formatRelative(att.attestedAt, now) : "—"}</b>
        </div>
        <div>
          <span>Balance as of</span>
          <b>{att ? formatClock(att.balanceAsOf) : "—"}</b>
        </div>
        <div className={due > 0 && done === due ? "accent" : undefined}>
          <span>Last 24 hours</span>
          <b>{due > 0 ? `${done} / ${due} checks` : "—"}</b>
        </div>
      </div>

      <div>
        <div className="proof-cells" aria-label="One cell per hour, the last 24 hours">
          {cells.map((c) => (
            <span
              key={c.hour}
              className={`proof-cell ${c.state}${c.band !== undefined ? ` band-${c.band}` : ""}`}
              title={`${formatClock(c.hour)} · ${
                c.state === "attested"
                  ? BANDS[c.band!]!.label
                  : c.state === "missed"
                    ? "missed — the DON's run failed this hour"
                    : c.state === "pending"
                      ? "not run yet"
                      : "before the first check"
              }`}
            />
          ))}
        </div>
        <div className="proof-axis muted-strong">
          {cells
            .filter((_, i) => i % 6 === 0)
            .map((c) => (
              <span key={c.hour}>{formatClock(c.hour).slice(0, 5)}</span>
            ))}
          <span>now</span>
        </div>
      </div>

      <div className="proof-privacy">
        <div>
          <div className="proof-privacy-head">Published on chain</div>
          <ul>
            <li>The coverage band</li>
            <li>What the tokens are worth — public anyway</li>
            <li>When the balance was read</li>
            <li>A keyed hash of the custodian's answer</li>
          </ul>
        </div>
        <div className="proof-sealed">
          <div className="proof-privacy-head">🔒 Never leaves the enclave</div>
          <ul>
            <li>The balance</li>
            <li>The custodian account</li>
            <li>The API key that reads it</li>
          </ul>
        </div>
      </div>

      <div className="muted-strong" style={{ fontSize: 11 }}>
        Only a band is published: with the tokens' value on chain, an exact ratio would give the balance away.
        Read inside an AWS Nitro enclave, agreed by the Chainlink DON, written to{" "}
        <a href={addressUrl(att?.address ?? RESERVE_ATTESTATION_ADDRESS)} target="_blank" rel="noreferrer">
          the attestation contract ↗
        </a>
      </div>
    </section>
  );
}
