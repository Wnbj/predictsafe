import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { erc20Abi, type Address } from "viem";
import { BASE_TOKENS, basePublicClient } from "../lib/ccip";
import { checkArrivals, isPending, subscribeTransfers, transfersFor, type BridgeTransfer } from "../lib/transfers";

/**
 * The wallet's CCIP transfers, read from this browser's record of them, and a
 * watch for the pending ones that runs only while any are pending.
 * `onArrive` fires when one lands, so balances can be read again.
 */
export function useBridgeTransfers(account: Address, onArrive: () => void): BridgeTransfer[] {
  const list = useSyncExternalStore(
    subscribeTransfers,
    () => transfersFor(account),
    () => transfersFor(account),
  );
  const pending = list.some(isPending);

  useEffect(() => {
    if (!pending) return;
    let live = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        if ((await checkArrivals(account)) > 0 && live) onArrive();
      } catch {
        /* the next tick tries again */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // onArrive is a fresh closure each render; the watch should not restart for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, pending]);

  return list;
}

/**
 * The wallet's exchange tokens on Base Sepolia, by symbol. Read from Base's
 * public RPC, which is not the Sepolia budget, every 30 seconds.
 */
export function useBaseBalances(account: Address | null) {
  const [balances, setBalances] = useState<Record<string, bigint> | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    const entries = Object.entries(BASE_TOKENS).filter((e): e is [string, Address] => e[1] !== null);
    try {
      const values = await Promise.all(
        entries.map(([, token]) =>
          basePublicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        ),
      );
      setBalances(Object.fromEntries(entries.map(([symbol], i) => [symbol, values[i]!])));
    } catch {
      /* keep the last answer; the next poll tries again */
    }
  }, [account]);

  useEffect(() => {
    setBalances(null);
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return { balances, reload: load };
}
