import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { writeWithApproval } from "../lib/approval";
import { ASSET_IMAGES } from "../lib/categories";
import { sendMint, waitForTx } from "../lib/chain";
import { EXCHANGE_ADDRESS, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../lib/config";
import {
  ASSET_TOKEN_DECIMALS,
  estimateBuy,
  estimateSell,
  exchangeError,
  formatFeedPrice,
  marketState,
  placeBuyCall,
  placeSellCall,
  type ExchangeState,
  type OrderSide,
} from "../lib/exchange";
import { formatToken } from "../lib/format";
import { formatUnitsShort } from "./walletParts";

const PERCENTS = [25, 50, 75] as const;

type Phase = "form" | "approving" | "wallet" | "confirming" | "done";

/**
 * Placing an order: side, asset, amount with share buttons, what it is
 * estimated to get and when it will fill — then a closing screen. Shared by
 * the wallet's dialog and the Trade page's side panel, so the two cannot
 * drift apart. Side and asset are the caller's, so the page's asset list can
 * pick them too.
 *
 * What it must not hide: an order does NOT fill at the price shown. It fills
 * at the first new price after it is placed, so the figure here is an
 * estimate and the form says when the fill is likely, from the feed itself.
 */
export function TradeForm({
  account,
  state,
  usdc,
  now,
  side,
  onSide,
  assetId,
  onAssetId,
  baseBalances,
  onClose,
  onFinish,
  onBusy,
  onDone,
  onTransferBack,
}: {
  account: Address;
  state: ExchangeState;
  usdc: { balance: bigint; allowance: bigint };
  now: number;
  side: OrderSide;
  onSide: (s: OrderSide) => void;
  assetId: number;
  onAssetId: (id: number) => void;
  /** Tokens on Base Sepolia, by symbol: a sale needs them back on Sepolia first. */
  baseBalances: Record<string, bigint> | null;
  /** Shows a close button in the heading — for the dialog. */
  onClose?: () => void;
  /** The closing screen's button: close the dialog, or start a new order. */
  onFinish: () => void;
  /** While the wallet is asking, a dialog must not close under it. */
  onBusy?: (busy: boolean) => void;
  onDone: () => Promise<void> | void;
  onTransferBack: (symbol: string) => void;
}) {
  const setSide = onSide;
  const setAssetId = onAssetId;
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [placed, setPlaced] = useState<{ side: OrderSide; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const asset = state.assets.find((a) => a.id === assetId) ?? state.assets[0]!;
  const symbol = `s${asset.symbol}`;
  const buying = side === "buy";
  const decimals = buying ? TOKEN_DECIMALS : ASSET_TOKEN_DECIMALS;
  const available = buying ? usdc.balance : asset.balance;
  const onBase = baseBalances?.[symbol] ?? 0n;
  const m = marketState(asset, now);
  const busy = phase === "approving" || phase === "wallet" || phase === "confirming";

  let amount: bigint | null = null;
  try {
    amount = text && /^\d*\.?\d*$/.test(text) && text !== "." ? parseUnits(text, decimals) : null;
  } catch {
    amount = null;
  }
  const tooMuch = amount !== null && amount > available;
  const valid = amount !== null && amount > 0n && !tooMuch && asset.active;

  const price = asset.latest.answer;
  const buy = buying && amount ? estimateBuy(amount, price, asset.feedDecimals) : null;
  const sell = !buying && amount ? estimateSell(amount, price, asset.feedDecimals) : null;
  // The exchange pays sellers from its reserve; a sale it cannot cover is
  // refunded at fill time rather than paid in part.
  const beyondReserve = sell !== null && sell.payout > state.reserve;

  const signing = phase === "wallet" || phase === "approving";
  useEffect(() => {
    onBusy?.(signing);
  }, [onBusy, signing]);

  // Focus follows a change of side or asset, not the first render: on the
  // Trade page the form is part of the page and must not steal the scroll.
  const first = useRef(true);
  useEffect(() => {
    if (first.current && !onClose) {
      first.current = false;
      return;
    }
    first.current = false;
    inputRef.current?.focus();
  }, [side, assetId, onClose]);

  const switchSide = (s: OrderSide) => {
    setSide(s);
    setText("");
    setError(null);
  };

  // Shares round DOWN to what is worth reading — cents for mUSDC, six places
  // for a token — and Max is the exact balance.
  const setShare = (pct: number) => {
    setError(null);
    const raw = (available * BigInt(pct)) / 100n;
    const step = buying ? 10n ** 4n : 10n ** 12n;
    const v = pct === 100 ? raw : raw - (raw % step);
    setText(v === 0n ? "" : formatUnits(v, decimals));
  };

  const mint = async () => {
    setMinting(true);
    setError(null);
    try {
      await waitForTx(await sendMint(account, 100n * 10n ** BigInt(TOKEN_DECIMALS)), "Test mUSDC");
      await onDone();
    } catch (e) {
      setError(exchangeError(e));
    } finally {
      setMinting(false);
    }
  };

  const place = async () => {
    if (!valid || amount === null) return;
    setPhase("wallet");
    setError(null);
    try {
      await writeWithApproval({
        account,
        spender: EXCHANGE_ADDRESS,
        amount,
        ...(buying
          ? { allowance: usdc.allowance, call: placeBuyCall(asset.id, amount) }
          : { allowance: asset.allowance, token: asset.token, call: placeSellCall(asset.id, amount) }),
        label: "Order",
        onApproving: () => setPhase("approving"),
        onSubmitted: () => setPhase("confirming"),
      });
      setPlaced({ side, text: buying ? formatToken(amount) : `${formatUnitsShort(amount)} ${symbol}` });
      setPhase("done");
      await onDone();
    } catch (e) {
      setError(exchangeError(e));
      setPhase("form");
    }
  };

  const fmt = (v: bigint) => formatUnitsShort(v);

  return (
    <>
      <div className="modal-head">
        <div className="heading" style={{ fontSize: 18 }}>
          {phase === "done" ? "Order placed" : buying ? `Buy ${symbol}` : `Sell ${symbol}`}
        </div>
        {onClose && (
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={signing}>
            ×
          </button>
        )}
      </div>

      {phase === "done" && placed ? (
        <div className="bridge-done">
          <div className="bridge-done-icon" aria-hidden="true">{placed.side === "buy" ? "+" : "−"}</div>
          <div>
            {placed.side === "buy" ? "Buy" : "Sell"} order for <b>{placed.text}</b> is in.
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            It fills at the next new {asset.name.toLowerCase()} price — {m.expectedWait}. The Chainlink DON fills it
            on its own; nothing more to sign. Follow it in the wallet's Activity.
          </div>
          <button
            className="btn btn-accent"
            onClick={() => {
              setPlaced(null);
              setText("");
              setPhase("form");
              onFinish();
            }}
          >
            {onClose ? "Done" : "Place another order"}
          </button>
        </div>
      ) : (
        <>
          <div className="seg" style={{ width: "100%" }}>
            {(["buy", "sell"] as const).map((s) => (
              <button key={s} style={{ flex: 1 }} className={side === s ? "active" : ""} disabled={busy} onClick={() => switchSide(s)}>
                {s === "buy" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>

          <div className="trade-assets">
            {state.assets.map((a) => (
              <button
                key={a.id}
                className={a.id === asset.id ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setAssetId(a.id);
                  if (!buying) setText("");
                }}
              >
                {ASSET_IMAGES[a.symbol] && <img src={ASSET_IMAGES[a.symbol]} alt="" />}
                <span>
                  <b>{a.name}</b>
                  <span className="muted">{formatFeedPrice(a.latest.answer, a.feedDecimals)}</span>
                </span>
              </button>
            ))}
          </div>

          <div>
            <div className={`bridge-amount${tooMuch ? " invalid" : ""}`}>
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={text}
                disabled={busy}
                onChange={(e) => {
                  setError(null);
                  setText(e.target.value.replace(",", ".").replace(/[^\d.]/g, ""));
                }}
                aria-label={buying ? `${TOKEN_SYMBOL} to pay` : `${symbol} to sell`}
              />
              <span className="bridge-amount-symbol">{buying ? TOKEN_SYMBOL : symbol}</span>
            </div>
            <div className="trade-balance muted">
              <span>
                {buying ? "You pay" : "You sell"} · balance {buying ? formatToken(available) : `${fmt(available)} ${symbol}`}
              </span>
              {buying && (
                <button className="linklike" disabled={minting || busy} onClick={() => void mint()}>
                  {minting ? "Minting…" : "Get 100 test mUSDC"}
                </button>
              )}
            </div>
          </div>

          <div className="bridge-shares">
            {PERCENTS.map((p) => (
              <button key={p} className="pill" disabled={busy || available === 0n} onClick={() => setShare(p)}>
                {p}%
              </button>
            ))}
            <button className="pill" disabled={busy || available === 0n} onClick={() => setShare(100)}>
              Max
            </button>
          </div>

          <dl className="bridge-facts">
            <div>
              <dt>You get, at the latest price</dt>
              <dd>
                {buy ? `≈ ${fmt(buy.tokens)} ${symbol}` : sell ? `≈ ${formatToken(sell.payout)}` : "—"}
              </dd>
            </div>
            <div>
              <dt>Latest Chainlink price</dt>
              <dd>{formatFeedPrice(price, asset.feedDecimals)}</dd>
            </div>
            <div>
              <dt>Fee (0.3%)</dt>
              <dd>{buy ? formatToken(buy.fee) : sell ? formatToken(sell.fee) : "—"}</dd>
            </div>
            <div>
              <dt>Fills</dt>
              <dd style={{ textAlign: "right" }}>{m.moving ? m.expectedWait : "when the price moves"}</dd>
            </div>
          </dl>

          {!m.moving && (
            <div className="muted" style={{ fontSize: 12 }}>
              {m.state === "paused"
                ? "The feed's last update repeated its price — the market has probably closed. The order waits for the next new price, possibly not until it reopens."
                : "The market is closed and the price is not moving. The order waits for the first new price after it reopens."}
            </div>
          )}
          {!buying && available === 0n && onBase > 0n && (
            <div className="muted" style={{ fontSize: 13 }}>
              Your {fmt(onBase)} {symbol} is on Base Sepolia; the exchange is on Sepolia.{" "}
              <button className="linklike" style={{ color: "var(--color-accent)" }} onClick={() => onTransferBack(symbol)}>
                Bring it back with CCIP →
              </button>
            </div>
          )}
          {tooMuch && (
            <div style={{ color: "var(--color-negative)", fontSize: 13 }}>
              More than your {buying ? formatToken(available) : `${fmt(available)} ${symbol}`}.
            </div>
          )}
          {beyondReserve && (
            <div style={{ color: "var(--color-negative)", fontSize: 13 }}>
              Larger than the exchange's reserve ({formatToken(state.reserve)}) — it would be refunded, not paid.
            </div>
          )}
          {!asset.active && <div style={{ color: "var(--color-negative)", fontSize: 13 }}>This asset is not taking new orders.</div>}
          {error && <div style={{ color: "var(--color-negative)", fontSize: 13 }}>{error}</div>}

          <button className="btn btn-accent bridge-submit" disabled={!valid || busy} onClick={() => void place()}>
            {phase === "approving"
              ? "Approve in your wallet…"
              : phase === "wallet"
                ? "Confirm in your wallet…"
                : phase === "confirming"
                  ? "Waiting for Sepolia…"
                  : !valid
                    ? "Enter an amount"
                    : buying
                      ? `Buy ${symbol} for ${formatToken(amount!)}`
                      : `Sell ${fmt(amount!)} ${symbol}`}
          </button>
          <div className="muted-strong" style={{ fontSize: 11, textAlign: "center" }}>
            An estimate, not a quote: the order fills at the first new Chainlink price after it lands.
          </div>
        </>
      )}
    </>
  );
}
