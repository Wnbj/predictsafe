import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { txLabel } from "../lib/toasts";
import { TOKEN_DECIMALS, TOKEN_SYMBOL, txUrl } from "../lib/config";
import { formatToken, parseToken, statusLabel } from "../lib/format";
import {
  estimatePayout,
  impliedYesPercent,
  isOpenForStaking,
  canRequestSettlement,
  slippageBound,
} from "../lib/pricing";
import {
  quoteAmmSell,
  quoteAmmShares,
  sendAmmSell,
  sendAmmRedeem,
  sendClaim,
  sendMint,
  sendRequestSettlement,
  waitForTx,
  ammBuyCall,
  stakeCall,
  type ContractCall,
} from "../lib/chain";
import { canBatch, headroomLabel, writeWithApproval } from "../lib/approval";
import { isAmm as isAmmMarket, MarketStatus, type Market, type Position, type Side } from "../lib/types";
import type { WalletState } from "../hooks/useWallet";

type Busy = null | "approving" | "staking" | "claiming" | "minting" | "settling";

export function TradePanel({
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
  const [side, setSide] = useState<Side>("yes");
  const [amountText, setAmountText] = useState("1");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const amount = parseToken(amountText);
  const yes = impliedYesPercent(market);
  const open = isOpenForStaking(market, now);
  const account = wallet.account;

  const estimate = amount ? estimatePayout(market, side, amount) : null;
  const needsApproval = amount !== null && allowance < amount;
  // Asked once per wallet and cached, so the hint under the button can say
  // truthfully whether this will be one confirmation or two.
  const [batchable, setBatchable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!account) return;
    let live = true;
    void canBatch(account).then((ok) => live && setBatchable(ok));
    return () => {
      live = false;
    };
  }, [account]);
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

  const isAmm = isAmmMarket(market);
  /**
   * Buying and selling are the same trade in opposite directions, so they share
   * the side toggle and the amount box rather than becoming two panels. What
   * changes is the unit: buying spends collateral, selling spends shares.
   */
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const heldShares = mode === "sell" ? (side === "yes" ? position?.yes : position?.no) ?? 0n : 0n;

  /**
   * The AMM's quote, refreshed as the amount changes.
   *
   * Fetched from the contract rather than recomputed here: the number shown is
   * the number `buy` will return, and a UI that re-derives the curve can drift
   * from the one that actually executes.
   */
  const [quotedShares, setQuotedShares] = useState<bigint | null>(null);
  /** The pool's cut of this trade, shown rather than buried in the price. */
  const [quotedFee, setQuotedFee] = useState<bigint | null>(null);
  useEffect(() => {
    if (!isAmm || !amount || amount <= 0n) {
      setQuotedShares(null);
      setQuotedFee(null);
      return;
    }
    let cancelled = false;
    const quoting =
      mode === "buy"
        ? quoteAmmShares(market, side === "yes", amount).then((q) => ({
            out: q.shares,
            fee: q.fee,
          }))
        : quoteAmmSell(market, side === "yes", amount).then((q) => ({
            out: q.collateral,
            fee: q.fee,
          }));
    void quoting
      .then((q) => {
        if (!cancelled) {
          setQuotedShares(q.out);
          setQuotedFee(q.fee);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQuotedShares(null);
          setQuotedFee(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAmm, market, side, amount, mode]);

  /**
   * A write that spends mUSDC: approval and call in one confirmation where the
   * wallet can batch them, otherwise an approval with headroom first — see
   * lib/approval. Used to be approve-exactly-then-call, two prompts every time.
   */
  const runApproved = async (call: ContractCall) => {
    if (!account || !amount) return;
    setBusy("staking");
    setError(null);
    setLastTx(null);
    try {
      const hash = await writeWithApproval({
        account,
        spender: market.contract,
        amount,
        allowance,
        call,
        label: "Trade",
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

  /** The pool moved more than 1% since the quote was shown: show the new one instead of sending. */
  const priceMoved = (out: bigint, fee: bigint) => {
    setQuotedShares(out);
    setQuotedFee(fee);
    setError("The price moved since this quote. Check the new numbers above and press again.");
  };

  const doBuy = async () => {
    if (!account || !amount) return;
    // Bounded 1% under the quote on screen, not under a fresh one: see
    // slippageBound. If the pool has already moved past that, show the new
    // quote and let the trader press again.
    const fresh = await quoteAmmShares(market, side === "yes", amount);
    const bound = slippageBound(quotedShares, fresh.shares);
    if ("moved" in bound) return priceMoved(fresh.shares, fresh.fee);
    await runApproved(ammBuyCall(market, side === "yes", amount, bound.minOut));
  };

  const doSell = async () => {
    if (!account || !amount) return;
    // Re-quote immediately before submitting, same as buying, and allow 1%
    // below. Selling needs no approval — the shares are already held by the
    // contract's own bookkeeping, not by an ERC-20 the pool must be allowed to
    // move.
    const fresh = await quoteAmmSell(market, side === "yes", amount);
    const bound = slippageBound(quotedShares, fresh.collateral);
    if ("moved" in bound) return priceMoved(fresh.collateral, fresh.fee);
    await run("staking", (a) => sendAmmSell(a, market, side === "yes", amount, bound.minOut));
  };

  const doStake = async () => {
    if (!account || !amount) return;
    await runApproved(stakeCall(market, side === "yes", amount));
  };

  if (!account) {
    return (
      <aside className="trade-panel market-panel">
        <div className="eyebrow">Trade</div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {market.status === MarketStatus.Settled || market.status === MarketStatus.Void
            ? "Connect a wallet on Sepolia to claim what this market owes you."
            : `Connect a wallet on Sepolia to ${isAmm ? "trade" : "stake"} on this market.`}
        </p>
        <button className="btn btn-accent" onClick={() => void wallet.connect()}>
          Connect wallet
        </button>
      </aside>
    );
  }

  return (
    <aside className="trade-panel market-panel">
      <div className="eyebrow">Trade</div>

      {open ? (
        <>
          {isAmm && (
            <div className="seg" style={{ width: "100%" }}>
              <button
                className={mode === "buy" ? "active" : ""}
                style={{ flex: 1 }}
                onClick={() => setMode("buy")}
              >
                Buy
              </button>
              <button
                className={mode === "sell" ? "active" : ""}
                style={{ flex: 1 }}
                onClick={() => setMode("sell")}
                disabled={!position || (position.yes === 0n && position.no === 0n)}
                title={
                  position && (position.yes > 0n || position.no > 0n)
                    ? "Exit your position before expiry"
                    : "Nothing to sell yet"
                }
              >
                Sell
              </button>
            </div>
          )}

          <div className="side-pick">
            <button className={`yes${side === "yes" ? " active" : ""}`} onClick={() => setSide("yes")}>
              <span>Yes</span>
              <b>{yes === null ? "—" : `${yes.toFixed(0)}%`}</b>
            </button>
            <button className={`no${side === "no" ? " active" : ""}`} onClick={() => setSide("no")}>
              <span>No</span>
              <b>{yes === null ? "—" : `${(100 - yes).toFixed(0)}%`}</b>
            </button>
          </div>

          <div>
            <div className={`bridge-amount${(isAmm && mode === "sell" ? amount !== null && amount > heldShares : insufficient) ? " invalid" : ""}`}>
              <input
                type="text"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value.replace(",", "."))}
                placeholder="0.00"
                aria-label={isAmm && mode === "sell" ? "Shares to sell" : `Amount in ${TOKEN_SYMBOL}`}
              />
              <span className="bridge-amount-symbol">
                {isAmm && mode === "sell" ? `${side === "yes" ? "Yes" : "No"} shares` : TOKEN_SYMBOL}
              </span>
            </div>
            <div className="trade-balance muted">
              <span>
                {isAmm && mode === "sell"
                  ? `Holding ${formatToken(heldShares, { symbol: false })} ${side === "yes" ? "Yes" : "No"} shares`
                  : `Balance ${formatToken(balance)}`}
              </span>
              <button
                className="linklike"
                onClick={() => void run("minting", (a) => sendMint(a, 100_000_000n))}
                disabled={busy !== null}
                title="MockUSDC has an open mint for testing"
              >
                {busy === "minting" ? "Minting…" : "Get 100 test tokens"}
              </button>
            </div>
          </div>

          <div className="bridge-shares">
            {isAmm && mode === "sell"
              ? ([25, 50, 100] as const).map((p) => (
                  <button
                    key={p}
                    className="pill"
                    disabled={heldShares === 0n}
                    onClick={() => setAmountText(formatUnits((heldShares * BigInt(p)) / 100n, TOKEN_DECIMALS))}
                  >
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))
              : ([1, 10, 50] as const).map((n) => (
                  <button
                    key={n}
                    className="pill"
                    onClick={() => setAmountText(String((Number(amountText) || 0) + n))}
                  >
                    +{n}
                  </button>
                ))}
            {!(isAmm && mode === "sell") && (
              <button
                className="pill"
                disabled={balance === 0n}
                onClick={() => setAmountText(formatUnits(balance, TOKEN_DECIMALS))}
              >
                Max
              </button>
            )}
          </div>

          <dl className="bridge-facts">
            {isAmm ? (
              <>
                <div>
                  <dt>{mode === "buy" ? "Shares" : "You receive"}</dt>
                  <dd>
                    {quotedShares === null
                      ? "—"
                      : // Buying returns SHARES, selling returns money. Only one
                        // of the two is denominated in the token.
                        formatToken(quotedShares, { symbol: mode === "sell" })}
                  </dd>
                </div>
                <div>
                  <dt>Price per share</dt>
                  <dd>
                    {quotedShares && quotedShares > 0n && amount
                      ? mode === "buy"
                        ? `${(Number((amount * 10_000n) / quotedShares) / 100).toFixed(1)}¢`
                        : `${(Number((quotedShares * 10_000n) / amount) / 100).toFixed(1)}¢`
                      : "—"}
                  </dd>
                </div>
                {/*
                  * Shown as its own line rather than folded into the price. The
                  * fee is not the market maker's margin on a spread — it is paid
                  * to whoever provided the liquidity, and a trader is entitled to
                  * see the size of it before agreeing.
                  */}
                {isAmmMarket(market) && market.feeBps > 0 && (
                  <div>
                    <dt>Pool fee ({(market.feeBps / 100).toFixed(2)}%)</dt>
                    <dd>{quotedFee === null ? "—" : formatToken(quotedFee, { symbol: true })}</dd>
                  </div>
                )}
                {mode === "buy" && (
                  <div className="payout">
                    <dt>Payout if {side === "yes" ? "Yes" : "No"}</dt>
                    <dd>{quotedShares === null ? "—" : formatToken(quotedShares)}</dd>
                  </div>
                )}
              </>
            ) : (
              <div className="payout">
                <dt>Est. payout if {side === "yes" ? "Yes" : "No"}</dt>
                <dd>{estimate ? formatToken(estimate.payout) : "—"}</dd>
              </div>
            )}
          </dl>

          {estimate?.refundOnly && (
            <div style={{ fontSize: 11, color: "var(--color-accent-300)" }}>
              Nothing staked on the other side yet — as it stands this market would void and
              refund, not pay out.
            </div>
          )}

          <p className="muted-strong" style={{ fontSize: 11, margin: 0 }}>
            {isAmm
              ? mode === "buy"
                ? "Each share pays 1 mUSDC if you are right. The price is locked when you buy — later trades cannot change what you already hold. Submitted with a 1% slippage bound."
                : "Selling returns your shares to the pool at the current price, so you can take a profit or cut a loss without waiting for expiry. Submitted with a 1% slippage bound."
              : "Parimutuel: your share of the whole pot is fixed at settlement, so this estimate moves as others stake."}
          </p>

          {isAmm && mode === "sell" && amount !== null && amount > heldShares ? (
            <div style={{ fontSize: 12, color: "var(--color-negative)" }}>
              You only hold {formatToken(heldShares, { symbol: false })}{" "}
              {side === "yes" ? "Yes" : "No"} shares.
            </div>
          ) : (
            insufficient &&
            !(isAmm && mode === "sell") && (
              <div style={{ fontSize: 12, color: "var(--color-negative)" }}>
                Not enough {TOKEN_SYMBOL}.
              </div>
            )
          )}

          <button
            className="btn btn-accent bridge-submit"
            disabled={
              !amount ||
              amount <= 0n ||
              busy !== null ||
              wallet.wrongNetwork ||
              (isAmm && mode === "sell" ? amount > heldShares : insufficient)
            }
            onClick={() => void (isAmm ? (mode === "sell" ? doSell() : doBuy()) : doStake())}
          >
            {busy === "approving"
              ? "Approving…"
              : busy === "staking"
                ? isAmm
                  ? mode === "sell"
                    ? "Selling…"
                    : "Buying…"
                  : "Staking…"
                : isAmm && mode === "sell"
                  ? "Sell shares"
                  : needsApproval
                    ? isAmm
                      ? "Approve & buy"
                      : "Approve & stake"
                    : isAmm
                      ? "Buy shares"
                      : "Place stake"}
          </button>
          {needsApproval && mode === "buy" && batchable !== null && (
            <div className="muted" style={{ fontSize: 11, marginTop: -4 }}>
              {batchable
                ? "Approval and stake go together — one confirmation in your wallet."
                : `Two confirmations this time: an approval of ${headroomLabel}, then the stake. Your next stakes here up to that amount need only one.`}
            </div>
          )}
        </>
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>
          {isAmm ? "Trading" : "Staking"} is closed — market is{" "}
          {statusLabel(market.status).toLowerCase()}.
        </div>
      )}

      {canRequestSettlement(market, now) && (
        <>
          <button
            className="btn"
            style={{ width: "100%" }}
            disabled={busy !== null}
            onClick={() => void run("settling", (a) => sendRequestSettlement(a, market))}
            title="Emits SettlementRequested, which is what the CRE workflow listens for"
          >
            {busy === "settling" ? "Requesting…" : "Request settlement"}
          </button>
          {/* SettlementKeeper asks on everyone's behalf; the button is only
              for not waiting. Flights wait six hours so a late one has landed. */}
          <div className="muted-strong" style={{ fontSize: 11, marginTop: -4 }}>
            {market.categoryId === "flights"
              ? "Requested automatically six hours after this point, so a late flight has landed. Press to do it now."
              : "Requested automatically within about 40 minutes. Press to do it now."}
          </div>
        </>
      )}

      {/*
        * `shareClaimable`, not `claimable`. The latter is the whole-market
        * total and folds in the pool claim, which this button does not pay —
        * that is the Withdraw button in the liquidity panel below. Using the
        * total here labelled a 26.67 redemption as 40, and offered the button
        * at all to a provider whose deposit left them no shares, where
        * `redeem()` can only revert with NothingToRedeem.
        */}
      {position && position.shareClaimable > 0n && !position.claimed && (
        <button
          className="btn btn-accent"
          style={{ width: "100%" }}
          disabled={busy !== null}
          onClick={() =>
            void run("claiming", (a) => (isAmm ? sendAmmRedeem(a, market) : sendClaim(a, market)))
          }
        >
          {busy === "claiming"
            ? isAmm
              ? "Redeeming…"
              : "Claiming…"
            : `${isAmm ? "Redeem" : "Claim"} ${formatToken(position.shareClaimable)}`}
        </button>
      )}

      {position && (
        <div className="market-position">
          <span className="muted">{isAmm ? "Your shares" : "Your stake"}</span>
          <span>
            <b className="up">{formatToken(position.yes, { symbol: !isAmm })}</b> Yes ·{" "}
            <b>{formatToken(position.no, { symbol: !isAmm })}</b> No
          </span>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "var(--color-negative)" }}>{error}</div>
      )}

      {lastTx && (
        <a
          href={txUrl(lastTx)}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 11, color: "var(--color-accent)" }}
        >
          View transaction ↗
        </a>
      )}
    </aside>
  );
}

/** Wallet/RPC errors are verbose; surface the useful line and the contract's own reverts. */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied transaction/i.test(msg)) return "Transaction rejected in wallet.";
  if (/BadStatus/.test(msg)) return "Market is not in a state that allows this.";
  if (/TooLate/.test(msg)) return "Staking has closed for this market.";
  if (/TooEarly/.test(msg)) return "Too early — settlement is not yet allowed.";
  if (/NothingToClaim/.test(msg)) return "Nothing to claim on this market.";
  if (/AlreadyClaimed/.test(msg)) return "Already claimed.";
  // The AMM's own reverts. Without these the user saw a raw selector for the
  // most ordinary failures on the contract — a price that moved under them,
  // or a claim they had already made.
  if (/SlippageTooHigh/.test(msg)) return "Price moved — try again, or trade a smaller size.";
  if (/NotEnoughShares/.test(msg)) return "You do not hold that many shares.";
  if (/NothingToRedeem/.test(msg)) return "Nothing to redeem on this market.";
  if (/AlreadyRedeemed/.test(msg)) return "Already redeemed.";
  if (/AlreadyWithdrawn/.test(msg)) return "Liquidity already withdrawn.";
  if (/NotAnLp/.test(msg)) return "This wallet has not provided liquidity here.";
  if (/NoLiquidity/.test(msg)) return "Amount is too small for this pool.";
  if (/insufficient funds/i.test(msg)) return "Not enough Sepolia ETH for gas.";
  const first = msg.split("\n")[0];
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}
