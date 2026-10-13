import { useEffect, useState } from "react";

/**
 * Transaction notices, one per hash: sent → confirmed or failed.
 *
 * Module-level rather than React context because the thing that knows a
 * transaction exists is `waitForTx` in lib/chain, which every write path
 * already calls and which is not a component. Kept tiny on purpose — a store,
 * a subscribe, and a hook.
 */

export type ToastState = "pending" | "success" | "error";

export interface Toast {
  id: string;
  state: ToastState;
  title: string;
  detail?: string;
  href?: string;
}

let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const emit = () => {
  for (const l of listeners) l(toasts);
};

/** How long a finished notice stays. A pending one stays until it finishes. */
const LINGER_MS: Record<ToastState, number | null> = { pending: null, success: 6_000, error: 12_000 };

export function showToast(t: Toast) {
  toasts = [...toasts.filter((x) => x.id !== t.id), t].slice(-4);
  const old = timers.get(t.id);
  if (old) clearTimeout(old);
  const linger = LINGER_MS[t.state];
  if (linger !== null) timers.set(t.id, setTimeout(() => dismissToast(t.id), linger));
  emit();
}

/** The notices on screen now, for tests and non-React callers. */
export const getToasts = (): readonly Toast[] => toasts;

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  timers.delete(id);
  emit();
}

export function useToasts(): Toast[] {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** What a panel's busy state is called in a notice. */
export function txLabel(busy: string | null): string {
  if (!busy) return "Transaction";
  if (busy.startsWith("fill-")) return "Fill";
  if (busy.startsWith("cancel-")) return "Take-back";
  return (
    {
      approving: "Approval",
      staking: "Trade",
      claiming: "Claim",
      minting: "Test mUSDC",
      settling: "Settlement request",
      adding: "Liquidity deposit",
      withdrawing: "Liquidity withdrawal",
      placing: "Order",
    } as Record<string, string>
  )[busy] ?? "Transaction";
}
