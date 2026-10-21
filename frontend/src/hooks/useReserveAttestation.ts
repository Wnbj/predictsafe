import { useEffect, useState } from "react";
import { parseAbi, parseAbiItem } from "viem";
import { priorityClient } from "../lib/chain";
import { RESERVE_ATTESTATION_ADDRESS, RESERVE_ATTESTATION_PREVIOUS } from "../lib/config";

/**
 * The latest off-chain reserve attestation: a coverage band from the
 * confidential workflow, never a balance. Polled once a minute — it changes
 * once an hour.
 */
export interface ReserveAttestation {
  /** 0 below 100%, then at least 100, 150, 200, 300, 400, 500% — see BANDS. */
  band: number;
  /** What the tokens were worth when attested, mUSDC units. */
  obligations: bigint;
  balanceAsOf: number;
  attestedAt: number;
  /** The contract the latest attestation came from. */
  address: `0x${string}`;
  /** Recent attestations from both contracts, oldest first — about a day and a half. */
  history: { band: number; balanceAsOf: number }[];
}

/** Each band: its label, the multiple of the tokens' value it guarantees, and a sentence. */
export const BANDS = [
  { label: "Below 100%", short: "<100%", times: 0, says: "The custodian holds less than the tokens are worth." },
  { label: "At least 100%", short: "100%", times: 1, says: "Every token is backed at least once over." },
  { label: "At least 150%", short: "150%", times: 1.5, says: "The custodian holds at least 1.5× what the tokens are worth." },
  { label: "At least 200%", short: "200%", times: 2, says: "The custodian holds at least 2× what the tokens are worth." },
  { label: "At least 300%", short: "300%", times: 3, says: "The custodian holds at least 3× what the tokens are worth." },
  { label: "At least 400%", short: "400%", times: 4, says: "The custodian holds at least 4× what the tokens are worth." },
  { label: "At least 500%", short: "500%", times: 5, says: "The custodian holds at least 5× what the tokens are worth." },
] as const;
export const BAND_LABEL = BANDS.map((b) => b.label);

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

export type HourState = "attested" | "missed" | "pending" | "before";
export interface HourCell {
  /** Start of the hour, unix seconds — the custodian's `asOf` for that hour's check. */
  hour: number;
  state: HourState;
  band?: number;
}

/**
 * The last `hours` hours as cells, oldest first. An hour is attested if an
 * attestation carries its start as `asOf`; missed if its :45 run has passed
 * without one, after attestations began; pending if its run is still ahead;
 * and "before" if it predates the first attestation in the history.
 */
export function hourCells(
  history: readonly { band: number; balanceAsOf: number }[],
  nowSeconds: number,
  hours = 24,
): HourCell[] {
  const byHour = new Map(history.map((h) => [Math.floor(h.balanceAsOf / 3600) * 3600, h.band]));
  const first = history.length ? Math.min(...history.map((h) => h.balanceAsOf)) : Infinity;
  const current = Math.floor(nowSeconds / 3600) * 3600;
  const cells: HourCell[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hour = current - i * 3600;
    const band = byHour.get(hour);
    if (band !== undefined) cells.push({ hour, state: "attested", band });
    else if (hour + ATTESTATION_MINUTE * 60 + 120 > nowSeconds) cells.push({ hour, state: "pending" });
    else if (hour < first) cells.push({ hour, state: "before" });
    else cells.push({ hour, state: "missed" });
  }
  return cells;
}

const attestedEvent = parseAbiItem(
  "event Attested(uint8 indexed band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash)",
);

/**
 * The history, from both contracts' events in one `getLogs` over the last
 * 10,000 blocks — the free RPC's cap, about 33 hours on Sepolia, which at one
 * attestation an hour is all a day of cells needs.
 */
async function readHistory(): Promise<{ band: number; balanceAsOf: number }[]> {
  const head = await priorityClient.getBlockNumber();
  const logs = await priorityClient.getLogs({
    address: [RESERVE_ATTESTATION_ADDRESS, RESERVE_ATTESTATION_PREVIOUS],
    event: attestedEvent,
    fromBlock: head > 9_999n ? head - 9_999n : 0n,
    toBlock: head,
  });
  return logs
    .map((l) => ({ band: Number(l.args.band), balanceAsOf: Number(l.args.balanceAsOf) }))
    .sort((a, b) => a.balanceAsOf - b.balanceAsOf);
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
    let seen = "";
    let history: { band: number; balanceAsOf: number }[] = [];
    const load = async () => {
      try {
        const [latest, count, prevLatest, prevCount] = await priorityClient.multicall({
          contracts: [
            { address: RESERVE_ATTESTATION_ADDRESS, abi, functionName: "latest" },
            { address: RESERVE_ATTESTATION_ADDRESS, abi, functionName: "count" },
            { address: RESERVE_ATTESTATION_PREVIOUS, abi, functionName: "latest" },
            { address: RESERVE_ATTESTATION_PREVIOUS, abi, functionName: "count" },
          ],
          allowFailure: false,
        });
        if (!live) return;
        // The new contract once it has spoken; until then, the old one's last word.
        const [a, address] =
          count > 0n ? [latest, RESERVE_ATTESTATION_ADDRESS] : [prevLatest, RESERVE_ATTESTATION_PREVIOUS];
        if (count === 0n && prevCount === 0n) {
          setState(null);
          return;
        }
        const current = {
          band: Number(a.band),
          obligations: a.obligations,
          balanceAsOf: Number(a.balanceAsOf),
          attestedAt: Number(a.attestedAt),
          address,
        };
        // The band first, then the cells: the history is one more, slower
        // request, and the band must not wait for it.
        setState({ ...current, history });
        const key = `${count}:${prevCount}`;
        if (key !== seen) {
          seen = key;
          // A failed history read leaves the cells as they were.
          history = await readHistory().catch(() => history);
          if (live) setState({ ...current, history });
        }
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
