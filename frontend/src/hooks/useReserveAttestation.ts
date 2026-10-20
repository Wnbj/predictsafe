import { useEffect, useState } from "react";
import { parseAbi } from "viem";
import { priorityClient } from "../lib/chain";
import { RESERVE_ATTESTATION_ADDRESS } from "../lib/config";

/**
 * The latest off-chain reserve attestation: a coverage band from the
 * confidential workflow, never a balance. Polled once a minute — it changes
 * once an hour.
 */
export interface ReserveAttestation {
  /** 0 below 100%, 1 at least 100%, 2 at least 150%, 3 at least 200%. */
  band: number;
  /** What the tokens were worth when attested, mUSDC units. */
  obligations: bigint;
  balanceAsOf: number;
  attestedAt: number;
  count: number;
}

const abi = parseAbi([
  "struct Attestation { uint8 band; uint256 obligations; uint64 balanceAsOf; uint64 attestedAt; bytes32 evidenceHash; }",
  "function latest() view returns (Attestation)",
  "function count() view returns (uint256)",
]);

export function useReserveAttestation(): ReserveAttestation | null | undefined {
  // undefined: still reading; null: nothing attested yet.
  const [state, setState] = useState<ReserveAttestation | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [latest, count] = await priorityClient.multicall({
          contracts: [
            { address: RESERVE_ATTESTATION_ADDRESS, abi, functionName: "latest" },
            { address: RESERVE_ATTESTATION_ADDRESS, abi, functionName: "count" },
          ],
          allowFailure: false,
        });
        if (!live) return;
        setState(
          count === 0n
            ? null
            : {
                band: Number(latest.band),
                obligations: latest.obligations,
                balanceAsOf: Number(latest.balanceAsOf),
                attestedAt: Number(latest.attestedAt),
                count: Number(count),
              },
        );
      } catch {
        if (live) setState((s) => (s === undefined ? null : s));
      }
    };
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return state;
}

export const BAND_LABEL = ["Below 100%", "At least 100%", "At least 150%", "At least 200%"] as const;
