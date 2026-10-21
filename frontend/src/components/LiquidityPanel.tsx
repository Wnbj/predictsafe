import { useEffect, useState } from "react";
import type { Address } from "viem";
import { txLabel } from "../lib/toasts";
import { TOKEN_DECIMALS, TOKEN_SYMBOL, txUrl } from "../lib/config";
import { formatToken, formatSigned, parseToken } from "../lib/format";
import {
  quoteAmmAddLiquidity,
  sendAmmWithdrawLiquidity,
  waitForTx,
  ammAddLiquidityCall,
} from "../lib/chain";
import { writeWithApproval } from "../lib/approval";
import { depositScenarios, depositThenTrade, feesOn, lpPnl, lpScenarios, residualValue } from "../lib/lp";
import { outcomeLabel as sportsOutcomeLabel } from "../lib/sports";
import { MarketStatus, type Market, type Position, type TradeEvent, isAmm } from "../lib/types";
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
  trades,
  onDone,
}: {
  market: Market;
  wallet: WalletState;
  balance: bigint;
  allowance: bigint;
  position: Position | undefined;
  now: number;
  /** This market's trades, for the volume a depositor would be earning fees on. */
  trades: TradeEvent[];
  onDone: () => void;
}) {
  const [amountText, setAmountText] = useState("10");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  /** null: follow the default — open only for a wallet already providing here. */
  const [showAdvanced, setShowAdvanced] = useState<boolean | null>(null);
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
    if (!isAmm(market) || !amount || amount <= 0n) {
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

  if (!isAmm(market)) return null;

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
    // Re-quoted immediately before submitting, then bounded 1% below, exactly
    // as a trade is: the pool can move between render and signature.
    const fresh = await quoteAmmAddLiquidity(market, amount);
    const minOut = (fresh.lpShares * 99n) / 100n;
    setBusy("adding");
    setError(null);
    setLastTx(null);
    try {
      // Approval and deposit in one confirmation where the wallet can batch
      // them — see lib/approval.
      const hash = await writeWithApproval({
        account,
        spender: market.contract,
        amount,
        allowance,
        call: ammAddLiquidityCall(market, amount, minOut),
        label: "Liquidity deposit",
        onApproving: () => setBusy("approving"),
      });
      setLastTx(hash);
      await onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const sharePct =
    lp && lp.totalShares > 0n ? Number((lp.shares * 10_000n) / lp.totalShares) / 100 : 0;
  const quotePct =
    quote && market.totalLpShares + quote.lpShares > 0n
      ? Number((quote.lpShares * 10_000n) / (market.totalLpShares + quote.lpShares)) / 100
      : 0;

  /*
   * Only the shares the DEPOSITS handed back — not the wallet's whole holding.
   * Valuing every share here put trades into the liquidity P&L: a provider who
   * had also bought 52 mUSDC of shares on the same market read "+56.52 mUSDC
   * (IL +56.52)" for a deposit that was exactly flat. The same held after
   * settlement, where `shareEntitlement` paid out the traded shares too.
   */
  const residual = lp ? residualValue(market, lp, position?.yes ?? 0n, position?.no ?? 0n) : 0n;
  const pnl = lp ? lpPnl(lp, residual) : null;

  const yesLabel = market.categoryId === "sports" ? `If ${sportsOutcomeLabel(market)}${market.match.outcome === 2 ? "" : " win"}` : "If Yes";
  const noLabel = market.categoryId === "sports" ? (market.match.outcome === 2 ? "If not a draw" : "If not") : "If No";
  const held = lp
    ? lpScenarios(
        market,
        lp.shares,
        lp.totalShares,
        lp.residualYes < (position?.yes ?? 0n) ? lp.residualYes : (position?.yes ?? 0n),
        lp.residualNo < (position?.no ?? 0n) ? lp.residualNo : (position?.no ?? 0n),
      )
    : null;
  const preview = quote && amount ? depositScenarios(market, amount, quote) : null;
  /*
   * The two halves of the role, in numbers, before anyone deposits: what the
   * fees pay on volume, and what one trade against the pool does — the
   * scenarios alone read "+0" both ways, which is true at the moment of
   * deposit and says nothing about where a result would come from.
   */
  const quoteShareBps =
    quote && market.totalLpShares + quote.lpShares > 0n
      ? (quote.lpShares * 10_000n) / (market.totalLpShares + quote.lpShares)
      : 0n;
  const one = 10n ** BigInt(TOKEN_DECIMALS);
  const feePerThousand = isAmm(market) ? feesOn(1_000n * one, market.feeBps, quoteShareBps) : 0n;
  const volume = trades.reduce((sum, t) => sum + (t.amm ? t.amount : 0n), 0n);
  const tradeCount = trades.filter((t) => t.amm).length;
  const exampleTrade = amount ? ((amount / 2n / one) > 0n ? (amount / 2n / one) * one : one) : 0n;
  const afterTrade =
    quote && amount && amount > 0n ? depositThenTrade(market, amount, quote, exampleTrade, true) : null;
  // Folded until asked for, unless this wallet already provides here.
  const expanded = showAdvanced ?? Boolean(lp);

  return (
    <aside className="trade-panel" style={{ marginTop: "var(--space-4)" }}>
      <button className="lp-toggle" onClick={() => setShowAdvanced(!expanded)} aria-expanded={expanded}>
        <span className="eyebrow">Provide liquidity · advanced</span>
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>

      {!expanded ? (
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Be the market maker instead of a player: earn {(market.feeBps / 100).toFixed(2)}% of every trade, and take
          the other side of whoever trades against the pool.
        </p>
      ) : (
        <>
          {/*
            * The role, in two sentences, before any number. A provider takes no
            * side by choice, but holds whatever traders sell to the pool — and
            * when they turn out right, that is the losing side. On a prediction
            * market that loss is realised at settlement, not "impermanent".
            */}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            You back every trade instead of picking a side. You earn the fees; when traders are right, the pool
            ends up holding what they sold it — and that part is lost at settlement. Most players should simply
            trade.
          </p>

          {lp && held && (
            <>
              <div className="lp-heading">Your liquidity</div>
              <dl className="bridge-facts">
                <div>
                  <dt>Put in</dt>
                  <dd>{formatToken(lp.deposited)} · {sharePct.toFixed(2)}% of the pool</dd>
                </div>
                <div>
                  <dt>Fees earned so far</dt>
                  <dd>{formatToken(lp.feesEarned)}</dd>
                </div>
                {!resolved && (
                  <>
                    <Scenario label={yesLabel} value={held.ifYes} against={lp.deposited} />
                    <Scenario label={noLabel} value={held.ifNo} against={lp.deposited} />
                  </>
                )}
                {resolved && pnl && (
                  <div>
                    <dt>Result</dt>
                    <dd className={pnl.pnl > 0n ? "up" : pnl.pnl < 0n ? "down" : undefined}>{formatSigned(pnl.pnl)}</dd>
                  </div>
                )}
              </dl>
              {!resolved && (
                <p className="muted-strong" style={{ fontSize: 11, margin: 0 }}>
                  If it settled on today's pool. Trades from here on move both numbers — fees in your favour, informed
                  traders against you.
                </p>
              )}
            </>
          )}

          {open && (
            <>
              <div className="lp-heading">{lp ? "Add more" : "Add liquidity"}</div>
              <div className="bridge-amount">
                <input
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value.replace(",", "."))}
                  aria-label="Liquidity to add"
                />
                <span className="bridge-amount-symbol">{TOKEN_SYMBOL}</span>
              </div>

              <dl className="bridge-facts">
                <div>
                  <dt>Share of the pool</dt>
                  <dd>{quote ? `${quotePct.toFixed(2)}%` : "—"}</dd>
                </div>
                {/*
                  * The surprising half, stated up front. The pool can only take
                  * a deposit in its own ratio, so whatever it cannot absorb comes
                  * back as a directional position — a depositor who is not told
                  * this discovers it only when the market settles against them.
                  */}
                {quote && (quote.yesResidual > 0n || quote.noResidual > 0n) && (
                  <div>
                    <dt>Shares you also keep</dt>
                    <dd>
                      {quote.yesResidual > 0n
                        ? `${formatToken(quote.yesResidual, { symbol: false })} Yes`
                        : `${formatToken(quote.noResidual, { symbol: false })} No`}
                    </dd>
                  </div>
                )}
                {quote && (
                  <div>
                    <dt>Your cut of the fees</dt>
                    <dd>
                      ~{formatToken(feePerThousand)} <span className="muted">per 1,000 {TOKEN_SYMBOL} traded</span>
                    </dd>
                  </div>
                )}
                {quote && (
                  <div>
                    <dt>Traded here so far</dt>
                    <dd>
                      {tradeCount === 0 ? "nothing yet" : `${tradeCount} trade${tradeCount === 1 ? "" : "s"} · ${formatToken(volume)}`}
                    </dd>
                  </div>
                )}
              </dl>

              {preview && amount !== null && amount > 0n && (
                <>
                  <div className="lp-subhead">If it settled right now, with no more trades</div>
                  <dl className="bridge-facts">
                    <Scenario label={yesLabel} value={preview.ifYes} against={amount} />
                    <Scenario label={noLabel} value={preview.ifNo} against={amount} />
                  </dl>
                </>
              )}
              {afterTrade && amount !== null && amount > 0n && (
                <>
                  <div className="lp-subhead">
                    The risk: if someone then buys {formatToken(exampleTrade)} of {market.categoryId === "sports" ? sportsOutcomeLabel(market) : "Yes"}
                  </div>
                  <dl className="bridge-facts">
                    <Scenario label={yesLabel} value={afterTrade.ifYes} against={amount} />
                    <Scenario label={noLabel} value={afterTrade.ifNo} against={amount} />
                  </dl>
                  <p className="muted-strong" style={{ fontSize: 11, margin: 0 }}>
                    The pool sold them those shares. If they turn out right, the pool pays them out and you, as part
                    of the pool, are down; if they are wrong, their money stays in the pool and you are up. Fees
                    come in either way.
                  </p>
                </>
              )}

              <button
                className="btn btn-accent bridge-submit"
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
              {busy === "withdrawing" ? "Withdrawing…" : `Withdraw ${formatToken(lp.poolValue)} from pool`}
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
        </>
      )}

      {error && <p style={{ color: "var(--color-negative)", fontSize: 11, margin: 0 }}>{error}</p>}
      {lastTx && (
        <a className="muted" style={{ fontSize: 11 }} href={txUrl(lastTx)} target="_blank" rel="noreferrer">
          View transaction
        </a>
      )}
    </aside>
  );
}

/** One outcome's payout, with how it compares to what went in. */
function Scenario({ label, value, against }: { label: string; value: bigint; against: bigint }) {
  const diff = value - against;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {formatToken(value)}{" "}
        <span className={diff > 0n ? "up" : diff < 0n ? "down" : "muted"} style={{ fontSize: 11 }}>
          ({formatSigned(diff)})
        </span>
      </dd>
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
