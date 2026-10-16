import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseUnits, type Address } from "viem";
import { writeWithApproval } from "../lib/approval";
import {
  bridgeFee,
  bridgeReady,
  CCIP_CHAINS,
  ccipExplorerTx,
  ccipSendCall,
  ensureWalletOn,
  readBridgeSide,
  type CcipSide,
} from "../lib/ccip";

/**
 * Move an exchange token between Ethereum Sepolia and Base Sepolia through
 * Chainlink CCIP — one row's worth of controls in the portfolio.
 *
 * Sending burns the tokens here and, once the DON has attested the message,
 * mints them there. From Sepolia that takes about twenty minutes, because CCIP
 * waits for the source block to be final; the link to CCIP Explorer is how
 * anyone watches it happen. Selling a token always needs it back on Sepolia,
 * where the exchange and its reserve are.
 */
export function BridgeControls({
  account,
  symbol,
  sepoliaBalance,
  onDone,
}: {
  account: Address;
  symbol: string;
  sepoliaBalance: bigint;
  onDone: () => void;
}) {
  const [base, setBase] = useState<{ balance: bigint; allowance: bigint; token: Address } | null>(null);
  const [from, setFrom] = useState<CcipSide | null>(null);
  const [amountText, setAmountText] = useState("");
  const [fee, setFee] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; from: CcipSide } | null>(null);

  const ready = bridgeReady(symbol);

  const refreshBase = useCallback(async () => {
    if (!ready) return;
    try {
      setBase(await readBridgeSide("base", symbol, account));
    } catch {
      /* the next poll will try again */
    }
  }, [account, symbol, ready]);

  useEffect(() => {
    void refreshBase();
    const t = setInterval(() => void refreshBase(), 30_000);
    return () => clearInterval(t);
  }, [refreshBase]);

  const available = from === "base" ? (base?.balance ?? 0n) : sepoliaBalance;
  let amount: bigint | null = null;
  try {
    amount = amountText ? parseUnits(amountText, 18) : null;
  } catch {
    amount = null;
  }
  const valid = amount !== null && amount > 0n && amount <= available;

  // Quote the fee for what is typed, against the side it leaves from.
  useEffect(() => {
    if (!from || !valid || amount === null) {
      setFee(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const side = await readBridgeSide(from, symbol, account);
        if (!side) return;
        const f = await bridgeFee(from, account, side.token, amount);
        if (live) setFee(f);
      } catch {
        if (live) setFee(null);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, amountText, account, symbol]);

  if (!ready) return null;

  const open = (side: CcipSide) => {
    setFrom(side);
    setError(null);
    setAmountText(formatUnits(side === "base" ? (base?.balance ?? 0n) : sepoliaBalance, 18));
  };

  const send = async () => {
    if (!from || !valid || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      if (from === "base") await ensureWalletOn("base");
      const side = await readBridgeSide(from, symbol, account);
      if (!side) throw new Error("This token is not deployed on that chain.");
      const f = await bridgeFee(from, account, side.token, amount);
      const hash = await writeWithApproval({
        account,
        spender: CCIP_CHAINS[from].router,
        amount,
        allowance: side.allowance,
        token: side.token,
        call: ccipSendCall(from, account, side.token, amount, f),
        label: "CCIP transfer",
        network: CCIP_CHAINS[from].network,
      });
      setSent({ hash, from });
      setFrom(null);
      onDone();
      void refreshBase();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /User rejected|denied/i.test(msg)
          ? "Rejected in wallet."
          : /insufficient funds/i.test(msg)
            ? `Not enough ${from === "base" ? "Base Sepolia" : "Sepolia"} ETH for gas and the CCIP fee.`
            : msg.split("\n")[0]!.slice(0, 160),
      );
    } finally {
      if (from === "base") void ensureWalletOn("sepolia").catch(() => {});
      setBusy(false);
    }
  };

  const fmt = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 6 });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
      <div className="muted">
        On Base Sepolia: <b style={{ color: "var(--color-text)" }}>{base ? fmt(base.balance) : "…"}</b> {symbol}
      </div>

      {!from && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {sepoliaBalance > 0n && (
            <button className="linklike" style={{ color: "var(--color-accent)" }} onClick={() => open("sepolia")}>
              Send to Base Sepolia →
            </button>
          )}
          {(base?.balance ?? 0n) > 0n && (
            <button className="linklike" style={{ color: "var(--color-accent)" }} onClick={() => open("base")}>
              ← Bring back to Sepolia
            </button>
          )}
        </div>
      )}

      {from && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 10, background: "var(--color-neutral-900)" }}>
          <div className="muted">
            {CCIP_CHAINS[from].name} → {CCIP_CHAINS[from === "sepolia" ? "base" : "sepolia"].name} via Chainlink CCIP
          </div>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value.replace(/[^\d.]/g, ""))}
            style={{ width: 200 }}
            aria-label={`${symbol} to send`}
          />
          <div className="muted">
            {fee !== null ? `CCIP fee ≈ ${Number(formatEther(fee)).toPrecision(3)} ETH` : valid ? "Quoting fee…" : "Enter an amount up to your balance."}
            {from === "base" && " · your wallet will switch to Base Sepolia and back"}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-accent" style={{ padding: "4px 12px", fontSize: 12 }} disabled={!valid || busy} onClick={() => void send()}>
              {busy ? "Sending…" : "Send"}
            </button>
            <button className="btn" style={{ padding: "4px 12px", fontSize: 12 }} disabled={busy} onClick={() => setFrom(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ color: "var(--color-negative)" }}>{error}</div>}

      {sent && (
        <div className="muted">
          Sent from {CCIP_CHAINS[sent.from].name} — arrives in about 20 minutes, once the block is final.{" "}
          <a href={ccipExplorerTx(sent.hash)} target="_blank" rel="noreferrer">
            Track on CCIP Explorer ↗
          </a>
        </div>
      )}
    </div>
  );
}
