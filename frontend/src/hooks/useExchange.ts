import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { EXCHANGE_ADDRESS } from "../lib/config";
import { readAllowance, readTokenBalance } from "../lib/chain";
import { readExchange, type ExchangeState } from "../lib/exchange";

/**
 * The exchange's state for one wallet, polled while a page that shows it is
 * mounted — every 30 seconds, because the free RPC's budget is shared with
 * every other open tab — and on demand after a transaction.
 *
 * Shared by the Trade page and the portfolio, so the two cannot disagree about
 * what a wallet holds.
 */
const POLL_MS = 30_000;

type Snapshot = [ExchangeState, bigint, bigint];

/**
 * A read already in flight for the same wallet is joined, not repeated. Two
 * callers mounting together — StrictMode's double effect in dev, or a page
 * and the nav — otherwise each paid a dozen paced requests for one answer.
 */
const inflight = new Map<string, Promise<Snapshot>>();

function readShared(account: Address | null, fresh: boolean): Promise<Snapshot> {
  const key = account ?? "";
  // After a transaction a read that started before it would answer with the
  // old state, so that caller starts its own and becomes the one others join.
  let p = fresh ? undefined : inflight.get(key);
  if (!p) {
    p = Promise.all([
      readExchange(account),
      account ? readTokenBalance(account) : Promise.resolve(0n),
      account ? readAllowance(account, EXCHANGE_ADDRESS) : Promise.resolve(0n),
    ]);
    const mine = p;
    void p.finally(() => {
      if (inflight.get(key) === mine) inflight.delete(key);
    }).catch(() => {});
    inflight.set(key, p);
  }
  return p;
}

export function useExchange(account: Address | null) {
  const [state, setState] = useState<ExchangeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<{ balance: bigint; allowance: bigint }>({ balance: 0n, allowance: 0n });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async (fresh: boolean) => {
    try {
      const [s, balance, allowance] = await readShared(account, fresh);
      setState(s);
      setUsdc({ balance, allowance });
      setError(null);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "read failed");
    }
    setNow(Math.floor(Date.now() / 1000));
  }, [account]);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => {
      if (!document.hidden) void load(false);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  /** For callers that just sent a transaction: never joins an older read. */
  const reload = useCallback(() => load(true), [load]);

  return { state, error, usdc, now, reload };
}
