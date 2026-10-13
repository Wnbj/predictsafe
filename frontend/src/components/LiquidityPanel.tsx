import { useEffect, useState } from "react";
import type { Address } from "viem";
import { txLabel } from "../lib/toasts";
import { TOKEN_SYMBOL, txUrl } from "../lib/config";
import { formatToken, formatSigned, parseToken } from "../lib/format";
import {
  quoteAmmAddLiquidity,
  sendAmmAddLiquidity,
  sendAmmWithdrawLiquidity,
  sendApprove,
  waitForTx,
} from "../lib/chain";
import { lpPnl, markShares } from "../lib/lp";
import { MarketStatus, type Market, type Position } from "../lib/types";
import type { WalletState } from "../hooks/useWallet";

type Busy = null | "approving" | "adding" | "withdrawing";

/**
 * Providing liquidity, on the market it belongs to.
 *
 * Deliberately its own panel rather than a third mode on the trade toggle:
 * depositing is not a trade. It takes no side, it does not move the price, and
 * what it earns comes from volume rather than from being right. Presenting it
 * as another way to buy would invite exactly the wrong mental model.
 */
export function LiquidityPanel({
  market,
  wallet,
  balance,
  allowance,
  position,
  now,
  onDone,
}: {
  market: Market;
  wallet: WalletState;
  balance: bigint;
  allowance: bigint;
  position: Position | undefined;
  now: number;
  onDone: () => void;
}) {
  const [amountText, setAmountText] = useState("10");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [quote, setQuote] = useState<
    { lpShares: bigint; yesResidual: bigint; noResidual: bigint } | null
  >(null);

  const amount = parseToken(amountText);
  const account = wallet.account;
  const lp = position?.lp;

  /**
   * Quoted from the contract, not recomputed here — the same discipline the
   * trade panel follows. The residual position in particular is easy to get
   * subtly wrong off-chain, and it is the part a depositor is least expecting.
   */
  useEffect(() => {
    if (market.categoryId !== "amm" || !amount || amount <= 0n) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    void quoteAmmAddLiquidity(market, amount)
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [market, amount]);

  if (market.categoryId !== "amm") return null;

  const open = market.status === MarketStatus.Open && now < market.closeTime;
  const resolved =
    market.status === MarketStatus.Settled || market.status === MarketStatus.Void;
  const insufficient = amount !== null && amount > balance;

  const run = async (label: Busy, fn: (acct: Address) => Promise<`0x${string}`>) => {
    if (!account) return;
    setBusy(label);
    setError(null);
    setLastTx(null);
    try {
      const hash = await fn(account);
      setLastTx(hash);
      await waitForTx(hash, txLabel(label));
      await onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const doAdd = async () => {
    if (!account || !amount) return;
    if (allowance < amount) {
      setBusy("approving");
      setError(null);
      try {
        const h = await sendApprove(account, market.contract, amount);
        setLastTx(h);
        await waitForTx(h, "Approval");
      } catch (e) {
        setError(friendlyError(e));
        setBusy(null);
        return;
      }
    }
    // Re-quoted immediately before submitting, then bounded 1% below, exactly
    // as a trade is: the pool can move between render and signature.
    const fresh = await quoteAmmAddLiquidity(market, amount);
    const minOut = (fresh.lpShares * 99n) / 100n;
    await run("adding", (a) => sendAmmAddLiquidity(a, market, amount, minOut));
  };

  const sharePct =
    lp && lp.totalShares > 0n ? Number((lp.shares * 10_000n) / lp.totalShares) / 100 : 0;
  const quotePct =
    quote && market.totalLpShares + quote.lpShares > 0n
      ? Number((quote.lpShares * 10_000n) / (market.totalLpShares + quote.lpShares)) / 100
      : 0;

  const residualValue = lp ? markShares(market, position?.yes ?? 0n, position?.no ?? 0n) : 0n;
  /*
   * `shareEntitlement`, not `entitlement`. `lpPnl` adds the pool claim itself,
   * and `entitlement` already contains it, so passing the total counted the
   * pool twice: a provider who got back exactly their deposit was reported up
   * by the size of their own pool claim, with a matching phantom IL.
   */
  const pnl = lp ? lpPnl(lp, resolved ? position?.shareEntitlement ?? 0n : residualValue) : null;

  return (
    <aside className="trade-panel" style={{ marginTop: "var(--space-4)" }}>
      <div className="eyebrow">Liquidity</div>

      {lp && (
        <div style={{ display: "grid", gap: 4, fontSize: 11 }} className="muted-strong">
          <Row label="Your share of the pool" value={`${sharePct.toFixed(2)}%`} />
          <Row label="Deposited" value={formatToken(lp.deposited)} />
          <Row
            label={lp.marked ? "Pool value (marked)" : "Pool claim"}
            value={formatToken(lp.poolValue)}
          />
          <Row label="Fees earned" value={formatToken(lp.feesEarned)} />
          {pnl && (
            <Row
              label={lp.marked ? "P&L if it settled now" : "P&L"}
              value={`${formatSigned(pnl.pnl)} (IL ${formatSigned(-pnl.impermanentLoss)})`}
            />
          )}
        </div>
      )}

      {open && (
        <>
          <label className="muted-strong" style={{ fontSize: 11 }}>
            Add liquidity
            <input
              className="input"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              style={{ marginTop: 4 }}
            />
          </label>

          <div style={{ display: "grid", gap: 4, fontSize: 11 }} className="muted-strong">
            <Row
              label="LP shares"
              value={quote ? formatToken(quote.lpShares, { symbol: false }) : "—"}
            />
            <Row label="Pool share" value={quote ? `${quotePct.toFixed(2)}%` : "—"} />
            {/*
              * The surprising half, stated up front. The pool can only take a
              * deposit in its own ratio, so whatever it cannot absorb comes
              * back as a directional position — a depositor who is not told
              * this discovers it only when the market settles against them.
              */}
            {quote && (quote.yesResidual > 0n || quote.noResidual > 0n) && (
              <Row
                label="Position you keep"
                value={
                  quote.yesResidual > 0n
                    ? `${formatToken(quote.yesResidual, { symbol: false })} Yes`
                    : `${formatToken(quote.noResidual, { symbol: false })} No`
                }
              />
            )}
          </div>

          <button
            className="btn btn-accent"
            disabled={!account || !amount || amount <= 0n || insufficient || busy !== null}
            onClick={() => void doAdd()}
          >
            {busy === "approving"
              ? "Approving…"
              : busy === "adding"
                ? "Adding…"
                : insufficient
                  ? `Not enough ${TOKEN_SYMBOL}`
                  : "Add liquidity"}
          </button>
        </>
      )}

      {/*
        * Withdrawing is a SEPARATE claim from redeeming shares, with its own
        * one-shot guard on chain. One button doing both would leave whichever
        * half it did not fire stranded permanently.
        */}
      {resolved && lp && !lp.withdrawn && (
        <button
          className="btn btn-accent"
          disabled={!account || busy !== null || lp.poolValue === 0n}
          onClick={() => void run("withdrawing", (a) => sendAmmWithdrawLiquidity(a, market))}
        >
          {busy === "withdrawing"
            ? "Withdrawing…"
            : `Withdraw ${formatToken(lp.poolValue)} from pool`}
        </button>
      )}

      {resolved && lp?.withdrawn && (
        <p className="muted" style={{ fontSize: 11, margin: 0 }}>
          Pool claim withdrawn. Any shares the deposit left you are redeemed separately.
        </p>
      )}

      {!open && !resolved && (
        <p className="muted" style={{ fontSize: 11, margin: 0 }}>
          Trading has closed — liquidity can be withdrawn once the market settles.
        </p>
      )}

      {market.feeBps > 0 && open && (
        <p className="muted" style={{ fontSize: 11, margin: 0 }}>
          Providers earn {(market.feeBps / 100).toFixed(2)}% of every trade, kept in the pool.
        </p>
      )}

      {error && (
        <p style={{ color: "var(--color-loss)", fontSize: 11, margin: 0 }}>{error}</p>
      )}
      {lastTx && (
        <a
          className="muted"
          style={{ fontSize: 11 }}
          href={txUrl(lastTx)}
          target="_blank"
          rel="noreferrer"
        >
          View transaction
        </a>
      )}
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

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied transaction/i.test(msg)) return "Transaction rejected in wallet.";
  if (/NoLiquidity/.test(msg)) return "Amount is too small for this pool's shape.";
  if (/SlippageTooHigh/.test(msg)) return "Pool moved — try again.";
  if (/AlreadyWithdrawn/.test(msg)) return "Liquidity already withdrawn.";
  if (/NotAnLp/.test(msg)) return "This wallet has not provided liquidity here.";
  if (/BadStatus/.test(msg)) return "Market is not in a state that allows this.";
  if (/TooLate/.test(msg)) return "Trading has closed for this market.";
  if (/insufficient funds/i.test(msg)) return "Not enough Sepolia ETH for gas.";
  const first = msg.split("\n")[0];
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}
