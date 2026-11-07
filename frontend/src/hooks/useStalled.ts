import { useEffect, useState } from "react";
import { WALLET_STALL_MS } from "../lib/waiting";

/** True once `active` has stayed true for `ms`; false again the moment it ends. */
export function useStalled(active: boolean, ms: number = WALLET_STALL_MS): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!active) return;
    const t = setTimeout(() => setStalled(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return stalled;
}
