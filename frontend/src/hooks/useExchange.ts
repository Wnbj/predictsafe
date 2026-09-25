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

export function useExchange(account: Address | null) {
  const [state, setState] = useState<ExchangeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<{ balance: bigint; allowance: bigint }>({ balance: 0n, allowance: 0n });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const reload = useCallback(async () => {
    try {
      const [s, balance, allowance] = await Promise.all([
        readExchange(account),
        account ? readTokenBalance(account) : Promise.resolve(0n),
        account ? readAllowance(account, EXCHANGE_ADDRESS) : Promise.resolve(0n),
      ]);
      setState(s);
      setUsdc({ balance, allowance });
      setError(null);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "read failed");
    }
    setNow(Math.floor(Date.now() / 1000));
  }, [account]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  return { state, error, usdc, now, reload };
}
