import { useMemo, useState } from "react";
import type { Address } from "viem";
import { EXCHANGE_ADDRESS, TOKEN_SYMBOL, addressUrl } from "../lib/config";
import { formatRelative, formatToken, parseToken, shortAddress } from "../lib/format";
import { sendApprove, sendMint, waitForTx } from "../lib/chain";
import {
  ASSET_TOKEN_DECIMALS,
  canCancel,
  estimateBuy,
  estimateSell,
  formatAssetAmount,
  formatFeedPrice,
  marketState,
  orderLabel,
  sendCancel,
  sendFill,
  sendPlaceBuy,
  sendPlaceSell,
  valueOf,
  type ExchangeAsset,
  type ExchangeOrder,
  type ExchangeState,
  type OrderSide,
} from "../lib/exchange";
import type { WalletState } from "../hooks/useWallet";
import { useExchange } from "../hooks/useExchange";
import { parseUnits } from "viem";

/**
 * The exchange page: synthetic gold and S&P 500, priced by Chainlink Data Feeds.
 *
 * It loads on its own rather than behind the markets read, because nothing
 * here depends on a market. Loading and polling live in `useExchange`, shared
 * with the portfolio.
 */

export function Trade({ wallet, onBalanceChange }: { wallet: WalletState; onBalanceChange: () => void }) {
  const account = wallet.account;
  const { state, error, usdc, now, reload } = useExchange(account);

  const refresh = async () => {
    await reload();
    onBalanceChange();
  };

  const [selected, setSelected] = useState(0);
  const asset = state?.assets[selected];

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Trade tokenized assets
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)", maxWidth: 780 }}>
        Synthetic gold and S&amp;P 500 tokens, priced by Chainlink Data Feeds. Every order fills at
        the <b>next new price</b> the feed publishes — never at a price anyone already knows, which
        is what stops a trader who watches the real market from draining the reserve.
      </p>

      <HowItWorks />

      {error && (
        <div className="card" style={{ color: "var(--color-negative)", marginBottom: "var(--space-6)" }}>
          Could not read the exchange: {error}
        </div>
      )}

      {!state ? (
        <div className="muted">Loading the exchange from Sepolia…</div>
      ) : (
        <>
          <div className="grid-2" style={{ marginBottom: "var(--space-8)", maxWidth: 1200 }}>
            {state.assets.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                now={now}
                selected={a.id === selected}
                onSelect={() => setSelected(a.id)}
              />
            ))}
          </div>

          <div className="split" style={{ maxWidth: 1200 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8)" }}>
              <Orders state={state} account={account} now={now} onDone={refresh} />
              <Reserve state={state} />
            </div>
            {asset && (
              <OrderPanel
                asset={asset}
                assets={state.assets}
                onPickAsset={setSelected}
                wallet={wallet}
                usdc={usdc}
                now={now}
                onDone={refresh}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["Place an order", "Your mUSDC — or, for a sale, your tokens — is held by the contract."],
    ["Wait for a new price", "Gold: about hourly on weekdays. S&P 500: about daily. Weekends: none."],
    ["Filled automatically", "Chainlink CRE fills it on a schedule. Anyone can too — at the same price."],
  ];
  return (
    <div className="grid-3" style={{ marginBottom: "var(--space-8)", maxWidth: 1200 }}>
      {steps.map(([title, text], i) => (
        <div key={title} className="card" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              flex: "none",
              display: "grid",
              placeItems: "center",
              background: "color-mix(in srgb, var(--color-accent) 25%, transparent)",
              color: "var(--color-accent-300)",
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {i + 1}
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
            <div className="muted" style={{ fontSize: 13 }}>{text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AssetCard({
  asset,
  now,
  selected,
  onSelect,
}: {
  asset: ExchangeAsset;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const m = marketState(asset, now);
  const price = asset.latest.answer;
  return (
    <button
      className="card card-interactive"
      onClick={onSelect}
      style={{
        textAlign: "left",
        cursor: "pointer",
        font: "inherit",
        color: "inherit",
        border: selected ? "1px solid var(--color-accent)" : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span className="tag">s{asset.symbol}</span>
        <span
          style={{
            fontSize: 12,
            color: m.moving ? "var(--color-accent-300)" : "var(--color-negative)",
          }}
        >
          {m.state === "moving" ? "● " : m.state === "paused" ? "◐ " : "○ "}
          {m.label}
        </span>
      </div>
      <div className="heading" style={{ fontSize: 20, marginBottom: 2 }}>
        Synthetic {asset.name}
      </div>
      <div style={{ fontSize: 30, fontWeight: 600, margin: "6px 0" }}>
        {formatFeedPrice(price, asset.feedDecimals)}
      </div>
      <div className="muted-strong" style={{ fontSize: 12, lineHeight: 1.6 }}>
        Feed updated {formatRelative(asset.latest.updatedAt, now)}
        {asset.lastChange && asset.lastChange.updatedAt !== asset.latest.updatedAt && (
          <> · price last changed {formatRelative(asset.lastChange.updatedAt, now)}</>
        )}
        <br />
        New orders fill {m.expectedWait}
        {asset.balance > 0n && (
          <>
            <br />
            You hold {formatAssetAmount(asset.balance, asset.symbol)} ≈{" "}
            {formatToken(valueOf(asset.balance, price, asset.feedDecimals))}
          </>
        )}
      </div>
    </button>
  );
}

type Busy = null | "approving" | "placing" | "minting" | `fill-${number}` | `cancel-${number}`;

function OrderPanel({
  asset,
  assets,
  onPickAsset,
  wallet,
  usdc,
  now,
  onDone,
}: {
  asset: ExchangeAsset;
  assets: ExchangeAsset[];
  onPickAsset: (id: number) => void;
  wallet: WalletState;
  usdc: { balance: bigint; allowance: bigint };
  now: number;
  onDone: () => Promise<void>;
}) {
  const [side, setSide] = useState<OrderSide>("buy");
  const [text, setText] = useState("100");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const account = wallet.account;
  const m = marketState(asset, now);

  // A buy is entered in mUSDC; a sale in asset tokens, which carry 18 decimals.
  const amount = useMemo(() => {
    if (side === "buy") return parseToken(text);
    try {
      return text.trim() && /^\d*\.?\d*$/.test(text.trim()) ? parseUnits(text.trim(), ASSET_TOKEN_DECIMALS) : null;
    } catch {
      return null;
    }
  }, [side, text]);

  const price = asset.latest.answer;
  const buy = side === "buy" && amount ? estimateBuy(amount, price, asset.feedDecimals) : null;
  const sell = side === "sell" && amount ? estimateSell(amount, price, asset.feedDecimals) : null;
  const needsApproval = side === "buy" && amount !== null && usdc.allowance < amount;
  const insufficient =
    amount !== null && (side === "buy" ? amount > usdc.balance : amount > asset.balance);

  const run = async (label: Busy, fn: (a: Address) => Promise<`0x${string}`>) => {
    if (!account) return;
    setBusy(label);
    setError(null);
    try {
      await waitForTx(await fn(account));
      await onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!account) {
    return (
      <aside className="trade-panel">
        <div className="eyebrow">Place an order</div>
        <p className="muted" style={{ fontSize: 13 }}>Connect a wallet on Sepolia to trade.</p>
        <button className="btn btn-accent" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      </aside>
    );
  }

  return (
    <aside className="trade-panel">
      <div className="eyebrow">Place an order</div>

      <div className="seg" style={{ width: "100%" }}>
        {assets.map((a) => (
          <button
            key={a.id}
            className={a.id === asset.id ? "active" : ""}
            style={{ flex: 1 }}
            onClick={() => onPickAsset(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>

      <div className="seg" style={{ width: "100%" }}>
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            className={side === s ? "active" : ""}
            style={{ flex: 1 }}
            onClick={() => {
              setSide(s);
              setText(s === "buy" ? "100" : "");
            }}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <div>
        <label className="muted-strong" style={{ display: "block", fontSize: 12, marginBottom: 5 }}>
          {side === "buy" ? `Pay (${TOKEN_SYMBOL})` : `Sell (s${asset.symbol})`}
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="0.00"
        />
        <div
          className="muted-strong"
          style={{ fontSize: 11, marginTop: 4, display: "flex", justifyContent: "space-between" }}
        >
          <span>
            {side === "buy"
              ? `Balance ${formatToken(usdc.balance)}`
              : `Holding ${formatAssetAmount(asset.balance, asset.symbol)}`}
          </span>
          {side === "buy" && (
            <button
              onClick={() => void run("minting", (a) => sendMint(a, 100_000_000n))}
              disabled={busy !== null}
              className="linklike"
              style={{ color: "var(--color-accent)", fontSize: 11, textDecoration: "none" }}
              title="MockUSDC has an open mint for testing"
            >
              {busy === "minting" ? "Minting…" : "Get 100 test tokens"}
            </button>
          )}
        </div>
      </div>

      <div className="muted-strong" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <Row label="Latest feed price" value={formatFeedPrice(price, asset.feedDecimals)} />
        {buy && <Row label="Estimate at that price" value={formatAssetAmount(buy.tokens, asset.symbol)} />}
        {sell && <Row label="Estimate at that price" value={formatToken(sell.payout)} />}
        <Row label="Fee" value={buy ? formatToken(buy.fee) : sell ? formatToken(sell.fee) : "0.3%"} />
      </div>

      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: 0 }}>
        {m.state === "moving"
          ? `This is an estimate. Your order fills at the next new price, ${m.expectedWait}.`
          : m.state === "paused"
            ? "The feed's last update repeated the previous price, which usually means the market has closed. Your order will wait for the next new price — possibly not until it reopens."
            : "The market is closed and the price is not moving. Your order will wait until the next new price after it reopens."}{" "}
        Unfilled orders can be taken back after 7 days.
      </p>

      {needsApproval ? (
        <button
          className="btn btn-accent"
          disabled={busy !== null || insufficient}
          onClick={() => void run("approving", (a) => sendApprove(a, EXCHANGE_ADDRESS, amount!))}
        >
          {busy === "approving" ? "Approving…" : `Approve ${TOKEN_SYMBOL}`}
        </button>
      ) : (
        <button
          className="btn btn-accent"
          disabled={busy !== null || !amount || amount === 0n || insufficient || !asset.active}
          onClick={() =>
            void run("placing", (a) =>
              side === "buy" ? sendPlaceBuy(a, asset.id, amount!) : sendPlaceSell(a, asset.id, amount!),
            )
          }
        >
          {busy === "placing"
            ? "Placing…"
            : insufficient
              ? side === "buy"
                ? `Not enough ${TOKEN_SYMBOL}`
                : `Not enough s${asset.symbol}`
              : side === "buy"
                ? `Place buy order`
                : `Place sell order`}
        </button>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--color-negative)" }}>{error}</div>}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <span style={{ color: "var(--color-text)" }}>{value}</span>
    </div>
  );
}

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

  // Your own orders when a wallet is connected; otherwise everyone's recent
  // ones, so the page shows the mechanism working before anyone signs in.
  const mine = account
    ? state.orders.filter((o) => o.trader.toLowerCase() === account.toLowerCase())
    : [];
  const shown = (account && mine.length ? mine : state.orders).slice().reverse().slice(0, 12);
  const title = account && mine.length ? "Your orders" : "Recent orders";

  const act = async (label: Busy, fn: (a: Address) => Promise<`0x${string}`>) => {
    if (!account) return;
    setBusy(label);
    setError(null);
    try {
      await waitForTx(await fn(account));
      await onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>{title}</div>
      {shown.length === 0 ? (
        <div className="card muted" style={{ fontSize: 13 }}>No orders yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Asset</th>
                <th>Side</th>
                <th>In</th>
                <th>Status</th>
                <th>Fill price</th>
                <th>Out</th>
                <th>Placed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <OrderRow
                  key={o.id}
                  o={o}
                  asset={state.assets[o.assetId]}
                  account={account}
                  now={now}
                  busy={busy}
                  onFill={() => void act(`fill-${o.id}`, (a) => sendFill(a, [o.id]))}
                  onCancel={() => void act(`cancel-${o.id}`, (a) => sendCancel(a, o.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--color-negative)", marginTop: 8 }}>{error}</div>}
      <p className="muted-strong" style={{ fontSize: 11, marginTop: 8 }}>
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
  now,
  busy,
  onFill,
  onCancel,
}: {
  o: ExchangeOrder;
  asset: ExchangeAsset | undefined;
  account: Address | null;
  now: number;
  busy: Busy;
  onFill: () => void;
  onCancel: () => void;
}) {
  const symbol = asset?.symbol ?? "?";
  const dec = asset?.feedDecimals ?? 8;
  const inText = o.side === "buy" ? formatToken(o.amountIn) : formatAssetAmount(o.amountIn, symbol);
  const outText =
    o.status !== "filled" ? "—" : o.side === "buy" ? formatAssetAmount(o.amountOut, symbol) : formatToken(o.amountOut);
  const color =
    o.status === "filled"
      ? "var(--color-accent-300)"
      : o.status === "refunded"
        ? "var(--color-negative)"
        : undefined;

  return (
    <tr>
      <td className="muted-strong">{o.id}</td>
      <td>s{symbol}</td>
      <td>{o.side === "buy" ? "Buy" : "Sell"}</td>
      <td>{inText}</td>
      <td style={{ color }}>{orderLabel(o)}</td>
      <td>
        {o.status === "filled"
          ? formatFeedPrice(o.fillPrice, dec)
          : o.ready
            ? formatFeedPrice(o.ready.price, dec)
            : "—"}
      </td>
      <td>{outText}</td>
      <td className="muted-strong">{formatRelative(o.placedAt, now)}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        {o.status === "pending" && o.ready && account && (
          <button className="btn" disabled={busy !== null} onClick={onFill} style={{ fontSize: 12, padding: "4px 10px" }}>
            {busy === `fill-${o.id}` ? "Filling…" : "Fill now"}
          </button>
        )}
        {canCancel(o, account, now) && (
          <button className="btn" disabled={busy !== null} onClick={onCancel} style={{ fontSize: 12, padding: "4px 10px" }}>
            {busy === `cancel-${o.id}` ? "Cancelling…" : "Take back"}
          </button>
        )}
      </td>
    </tr>
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
  const outstanding = state.assets.reduce(
    (sum, a) => sum + valueOf(a.totalSupply, a.latest.answer, a.feedDecimals),
    0n,
  );
  const coverage = outstanding > 0n ? Number((state.reserve * 1000n) / outstanding) / 10 : null;
  return (
    <section>
      <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>The reserve</div>
      <div className="grid-3">
        <div className="card">
          <div className="muted-strong" style={{ fontSize: 11 }}>AVAILABLE TO PAY SELLERS</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{formatToken(state.reserve)}</div>
        </div>
        <div className="card">
          <div className="muted-strong" style={{ fontSize: 11 }}>TOKENS OUTSTANDING, AT LATEST PRICES</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{formatToken(outstanding)}</div>
        </div>
        <div className="card">
          <div className="muted-strong" style={{ fontSize: 11 }}>COVERAGE</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{coverage === null ? "—" : `${coverage.toLocaleString()}%`}</div>
        </div>
      </div>
      <p className="muted-strong" style={{ fontSize: 11, marginTop: 8, maxWidth: 780 }}>
        This contract is the counterparty. When an asset rises, sellers are paid from the reserve;
        a sale the reserve cannot cover is refunded — the tokens come back — rather than paid in
        part. Buy orders still waiting ({formatToken(state.escrowed)}) are held apart and never
        used to pay anyone else.
      </p>
    </section>
  );
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied transaction/i.test(msg)) return "Transaction rejected in wallet.";
  if (/AssetInactive/.test(msg)) return "This asset is not taking new orders.";
  if (/TooEarlyToCancel/.test(msg)) return "Orders can be taken back 7 days after they were placed.";
  if (/NotYourOrder/.test(msg)) return "That order belongs to another wallet.";
  if (/BadFeedPrice/.test(msg)) return "The price feed returned no usable price.";
  if (/insufficient funds/i.test(msg)) return "Not enough Sepolia ETH for gas.";
  if (/ERC20InsufficientBalance/.test(msg)) return "Not enough balance for that amount.";
  const first = msg.split("\n")[0] ?? msg;
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}
