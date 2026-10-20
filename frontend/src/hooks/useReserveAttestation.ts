import { useEffect, useState } from "react";
import { parseAbi, parseAbiItem } from "viem";
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
  /** Recent attestations, oldest first — at most a day and a half of them. */
  history: { band: number; balanceAsOf: number }[];
}

/**
 * The workflow runs at minute 45 of every hour (cre/reserve-attestation,
 * `schedule: "0 45 * * * *"`). When the next run is due, for the card.
 */
export const ATTESTATION_MINUTE = 45;
export function nextAttestation(nowSeconds: number): number {
  const hour = Math.floor(nowSeconds / 3600) * 3600;
  const thisHour = hour + ATTESTATION_MINUTE * 60;
  return thisHour > nowSeconds ? thisHour : thisHour + 3600;
}

const attestedEvent = parseAbiItem(
  "event Attested(uint8 indexed band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash)",
);

/**
 * The history, from the contract's own events. One `getLogs` over the last
 * 10,000 blocks — the free RPC's cap, about 33 hours on Sepolia, which at one
 * attestation an hour is all a strip of bands needs. Fetched only when the
 * count moves.
 */
async function readHistory(): Promise<{ band: number; balanceAsOf: number }[]> {
  const head = await priorityClient.getBlockNumber();
  const logs = await priorityClient.getLogs({
    address: RESERVE_ATTESTATION_ADDRESS,
    event: attestedEvent,
    fromBlock: head > 9_999n ? head - 9_999n : 0n,
    toBlock: head,
  });
  return logs.map((l) => ({ band: Number(l.args.band), balanceAsOf: Number(l.args.balanceAsOf) }));
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
    let seenCount = -1;
    let history: { band: number; balanceAsOf: number }[] = [];
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
        if (Number(count) !== seenCount && count > 0n) {
          // A failed history read leaves the strip as it was; the band above it still shows.
          history = await readHistory().catch(() => history);
          seenCount = Number(count);
          if (!live) return;
        }
        setState(
          count === 0n
            ? null
            : {
                band: Number(latest.band),
                obligations: latest.obligations,
                balanceAsOf: Number(latest.balanceAsOf),
                attestedAt: Number(latest.attestedAt),
                count: Number(count),
                history,
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
