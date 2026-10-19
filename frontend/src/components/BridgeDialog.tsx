import { useEffect, useRef, useState } from "react";
import { formatEther, formatUnits, parseUnits, type Address } from "viem";
import { writeWithApproval } from "../lib/approval";
import { publicClient } from "../lib/chain";
import {
  basePublicClient,
  bridgeFee,
  CCIP_CHAINS,
  ccipExplorerTx,
  ccipSendCall,
  ensureWalletOn,
  readBridgeSide,
  type CcipSide,
} from "../lib/ccip";
import { valueOf } from "../lib/exchange";
import { destinationHead, recordTransfer } from "../lib/transfers";
import { ChainBadge, formatDollars, formatUnitsShort } from "./walletParts";

/** One asset as the dialog needs it: where it is and what it is worth. */
export interface BridgeAsset {
  symbol: string;
  name: string;
  image?: string;
  price: bigint;
  feedDecimals: number;
  sepolia: bigint;
  base: bigint | null;
}

const other = (s: CcipSide): CcipSide => (s === "sepolia" ? "base" : "sepolia");
const PERCENTS = [25, 50, 75] as const;

type Phase = "form" | "wallet" | "confirming" | "done";

/**
 * Moving a token between Ethereum Sepolia and Base Sepolia, as a wallet would
 * ask it: which token, which way, how much — with the share buttons people
 * expect, the fee and the wait stated before anything is signed, and a closing
 * screen that hands over the CCIP Explorer link.
 *
 * The transfer is recorded (lib/transfers) the moment its source transaction
 * confirms, from this closure rather than from component state, so closing the
 * dialog or leaving the page mid-confirmation still leaves it in Activity.
 */
export function BridgeDialog({
  account,
  assets,
  initial,
  onClose,
  onSent,
}: {
  account: Address;
  assets: BridgeAsset[];
  initial: { symbol: string; from: CcipSide };
  onClose: () => void;
  onSent: () => void;
}) {
  const [symbol, setSymbol] = useState(initial.symbol);
  const [from, setFrom] = useState<CcipSide>(initial.from);
  const [amountText, setAmountText] = useState("");
  const [fee, setFee] = useState<bigint | null>(null);
  const [eth, setEth] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const asset = assets.find((a) => a.symbol === symbol) ?? assets[0]!;
  const to = other(from);
  const available = (from === "base" ? asset.base : asset.sepolia) ?? 0n;

  let amount: bigint | null = null;
  try {
    amount = amountText && /^\d*\.?\d*$/.test(amountText) && amountText !== "." ? parseUnits(amountText, 18) : null;
  } catch {
    amount = null;
  }
  const tooMuch = amount !== null && amount > available;
  const valid = amount !== null && amount > 0n && !tooMuch;
  const busy = phase === "wallet" || phase === "confirming";

  // Escape closes, except while the wallet is open: the user is mid-signature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "wallet") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [symbol, from]);

  // Gas on the side it leaves from: the fee is paid in it, not in the token.
  useEffect(() => {
    let live = true;
    setEth(null);
    void (from === "base" ? basePublicClient : publicClient)
      .getBalance({ address: account })
      .then((b) => live && setEth(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [account, from]);

  // The fee for what is typed, quoted a moment after typing stops.
  useEffect(() => {
    setFee(null);
    if (!valid || amount === null) return;
    let live = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const side = await readBridgeSide(from, symbol, account);
          if (!side) return;
          const f = await bridgeFee(from, account, side.token, amount);
          if (live) setFee(f);
        } catch {
          /* shown as "quoting" until the next keystroke */
        }
      })();
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, amountText, account, symbol]);

  // A share is rounded DOWN to six places, which is all anyone reads; Max is
  // the exact balance, so nothing is left behind as dust.
  const setShare = (pct: number) => {
    setError(null);
    const raw = (available * BigInt(pct)) / 100n;
    const v = pct === 100 ? raw : raw - (raw % 10n ** 12n);
    setAmountText(v === 0n ? "" : formatUnits(v, 18));
  };

  const flip = () => {
    setFrom(to);
    setAmountText("");
    setError(null);
  };

  const lowGas = eth !== null && fee !== null && eth < fee;

  const send = async () => {
    if (!valid || amount === null) return;
    const sending = { from, to, symbol, amount };
    setPhase("wallet");
    setError(null);
    try {
      if (from === "base") await ensureWalletOn("base");
      const side = await readBridgeSide(from, symbol, account);
      if (!side) throw new Error("This token is not deployed on that chain.");
      const [f, head] = await Promise.all([
        bridgeFee(from, account, side.token, amount),
        destinationHead(to),
      ]);
      const hash = await writeWithApproval({
        account,
        spender: CCIP_CHAINS[from].router,
        amount,
        allowance: side.allowance,
        token: side.token,
        call: ccipSendCall(from, account, side.token, amount, f),
        label: "CCIP transfer",
        network: CCIP_CHAINS[from].network,
        onSubmitted: () => setPhase("confirming"),
      });
      recordTransfer(account, {
        hash,
        from: sending.from,
        to: sending.to,
        symbol: sending.symbol,
        amount: sending.amount.toString(),
        sentAt: Date.now(),
        destFromBlock: head.toString(),
        scannedTo: head.toString(),
      });
      setSentHash(hash);
      setPhase("done");
      onSent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /User rejected|denied/i.test(msg)
          ? "Rejected in the wallet — nothing was sent."
          : /insufficient funds/i.test(msg)
            ? `Not enough ${CCIP_CHAINS[from].name} ETH for gas and the CCIP fee.`
            : msg.split("\n")[0]!.slice(0, 160),
      );
      setPhase("form");
    } finally {
      if (from === "base") void ensureWalletOn("sepolia").catch(() => {});
    }
  };

  const value = valid && amount !== null ? valueOf(amount, asset.price, asset.feedDecimals) : null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && phase !== "wallet" && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="CCIP transfer">
        <div className="modal-head">
          <div className="heading" style={{ fontSize: 18 }}>
            {phase === "done" ? "On its way" : "CCIP Transfer"}
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={phase === "wallet"}>
            ×
          </button>
        </div>

        {phase === "done" ? (
          <div className="bridge-done">
            <div className="bridge-done-icon" aria-hidden="true">⇄</div>
            <div>
              <b>
                {amount !== null ? formatUnitsShort(amount) : amountText} {symbol}
              </b>{" "}
              left {CCIP_CHAINS[from].name} for {CCIP_CHAINS[to].name}.
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              It arrives once the source block is final — usually 15 to 30 minutes. You can leave this page: the
              transfer is in Activity, and the wallet shows it as in transit until it lands.
            </div>
            {sentHash && (
              <a className="btn" href={ccipExplorerTx(sentHash)} target="_blank" rel="noreferrer">
                Track on CCIP Explorer ↗
              </a>
            )}
            <button className="btn btn-accent" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            {assets.length > 1 && (
              <div className="seg" style={{ width: "100%" }}>
                {assets.map((a) => (
                  <button
                    key={a.symbol}
                    style={{ flex: 1 }}
                    className={a.symbol === symbol ? "active" : ""}
                    disabled={busy}
                    onClick={() => {
                      setSymbol(a.symbol);
                      setAmountText("");
                    }}
                  >
                    {a.symbol}
                  </button>
                ))}
              </div>
            )}

            <div className="bridge-route">
              <div className="bridge-end">
                <span className="muted-strong">From</span>
                <ChainBadge side={from} />
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatUnitsShort(available)} {symbol}
                </span>
              </div>
              <button className="bridge-flip" onClick={flip} disabled={busy} aria-label="Swap direction" title="Swap direction">
                ⇄
              </button>
              <div className="bridge-end">
                <span className="muted-strong">To</span>
                <ChainBadge side={to} />
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatUnitsShort(to === "base" ? (asset.base ?? 0n) : asset.sepolia)} {symbol}
                </span>
              </div>
            </div>

            <div className={`bridge-amount${tooMuch ? " invalid" : ""}`}>
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                placeholder="0.0"
                value={amountText}
                disabled={busy}
                onChange={(e) => {
                  setError(null);
                  setAmountText(e.target.value.replace(",", ".").replace(/[^\d.]/g, ""));
                }}
                aria-label={`${symbol} to send`}
              />
              <span className="bridge-amount-symbol">{symbol}</span>
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
              <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>
                {value !== null ? `≈ ${formatDollars(value)}` : ""}
              </span>
            </div>

            <dl className="bridge-facts">
              <div>
                <dt>Network fee (CCIP)</dt>
                <dd>{fee !== null ? `${Number(formatEther(fee)).toPrecision(2)} ETH` : valid ? "quoting…" : "—"}</dd>
              </div>
              <div>
                <dt>Your {from === "base" ? "Base Sepolia" : "Sepolia"} ETH</dt>
                <dd style={lowGas ? { color: "var(--color-negative)" } : undefined}>
                  {eth !== null ? Number(formatEther(eth)).toPrecision(3) : "…"}
                </dd>
              </div>
              <div>
                <dt>Arrives</dt>
                <dd>in about 15–30 min</dd>
              </div>
            </dl>

            {available === 0n && (
              <div className="muted" style={{ fontSize: 13 }}>
                No {symbol} on {CCIP_CHAINS[from].name}.{" "}
                {(to === "base" ? asset.base : asset.sepolia) ? (
                  <button className="linklike" style={{ color: "var(--color-accent)" }} onClick={flip}>
                    Send the other way →
                  </button>
                ) : null}
              </div>
            )}
            {tooMuch && (
              <div style={{ color: "var(--color-negative)", fontSize: 13 }}>
                More than the {formatUnitsShort(available)} {symbol} on {CCIP_CHAINS[from].name}.
              </div>
            )}
            {lowGas && (
              <div style={{ color: "var(--color-negative)", fontSize: 13 }}>
                Not enough {CCIP_CHAINS[from].name} ETH to pay the fee.
              </div>
            )}
            {from === "base" && !busy && (
              <div className="muted" style={{ fontSize: 12 }}>
                Your wallet will switch to Base Sepolia to sign, then back.
              </div>
            )}
            {error && <div style={{ color: "var(--color-negative)", fontSize: 13 }}>{error}</div>}

            <button className="btn btn-accent bridge-submit" disabled={!valid || busy || lowGas} onClick={() => void send()}>
              {phase === "wallet"
                ? "Confirm in your wallet…"
                : phase === "confirming"
                  ? `Waiting for ${CCIP_CHAINS[from].network.name}…`
                  : valid
                    ? `Transfer ${formatUnitsShort(amount!)} ${symbol} to ${CCIP_CHAINS[to].name}`
                    : "Enter an amount"}
            </button>
            <div className="muted-strong" style={{ fontSize: 11, textAlign: "center" }}>
              Burned here, minted there by Chainlink CCIP. Selling needs the tokens back on Sepolia.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
