import { parseAbiItem, zeroAddress, type Address } from "viem";
import { publicClient } from "./chain";
import { basePublicClient, tokenOn, type CcipSide } from "./ccip";

/**
 * CCIP transfers this browser has sent, kept until they arrive and after.
 *
 * A transfer is two transactions on two chains about twenty minutes apart, and
 * the first one is all the page sees. It used to live in a component's state,
 * so navigating away lost the only link to it and the tokens simply looked
 * gone: burned on one side, not yet minted on the other.
 *
 * So each one is written to localStorage the moment its source transaction
 * confirms, keyed by wallet, and watched from there: it has arrived when the
 * destination token MINTS that exact amount to that wallet, after the block
 * the destination chain was at when it was sent. A balance check would say
 * the same thing until the wallet moved anything else.
 */

export interface BridgeTransfer {
  /** The source transaction — also how CCIP Explorer finds the message. */
  hash: `0x${string}`;
  from: CcipSide;
  to: CcipSide;
  symbol: string;
  /** Token units, as a decimal string: JSON has no bigint. */
  amount: string;
  /** Unix ms, from this browser's clock. */
  sentAt: number;
  /** The destination chain's head just before sending; arrival is after it. */
  destFromBlock: string;
  /** The last destination block searched for the arrival, inclusive. */
  scannedTo: string;
  arrivedAt?: number;
  /** The destination transaction that minted it. */
  arrivalHash?: string;
}

const KEY_PREFIX = "predictsafe.ccip:1:";
const keyFor = (account: string) => `${KEY_PREFIX}${account.toLowerCase()}`;

const cache = new Map<string, BridgeTransfer[]>();
const listeners = new Set<() => void>();
const EMPTY: BridgeTransfer[] = [];

function read(account: string): BridgeTransfer[] {
  const key = keyFor(account);
  const hit = cache.get(key);
  if (hit) return hit;
  let list: BridgeTransfer[] = EMPTY;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) list = parsed as BridgeTransfer[];
  } catch {
    /* unreadable or blocked storage: start empty */
  }
  cache.set(key, list);
  return list;
}

function write(account: string, list: BridgeTransfer[]) {
  const key = keyFor(account);
  cache.set(key, list);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* private mode: the list still lives for this visit */
  }
  listeners.forEach((l) => l());
}

/** Newest first. The same array until something changes, for useSyncExternalStore. */
export const transfersFor = (account: string): BridgeTransfer[] => read(account);

export function subscribeTransfers(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recordTransfer(account: string, t: BridgeTransfer) {
  const list = read(account).filter((x) => x.hash !== t.hash);
  write(account, [t, ...list]);
}

function update(account: string, hash: string, patch: Partial<BridgeTransfer>) {
  write(
    account,
    read(account).map((t) => (t.hash === hash ? { ...t, ...patch } : t)),
  );
}

export const isPending = (t: BridgeTransfer) => t.arrivedAt === undefined;

/** Past this, the page stops promising and points at CCIP Explorer instead. */
export const SLOW_AFTER_MS = 45 * 60_000;

// --- arrival ------------------------------------------------------------------

export interface Mint {
  hash: string;
  logIndex: number;
  blockNumber: bigint;
  amount: bigint;
}

/**
 * The mint that delivers `t`, if `mints` holds one: the same amount, after the
 * block it was sent at, not already credited to another transfer. Two equal
 * transfers in flight each take a different mint, in order.
 */
export function findArrival(t: BridgeTransfer, mints: readonly Mint[], claimed: ReadonlySet<string>): Mint | null {
  const after = BigInt(t.destFromBlock);
  const amount = BigInt(t.amount);
  return (
    [...mints]
      .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex))
      .find((m) => m.blockNumber > after && m.amount === amount && !claimed.has(`${m.hash}:${m.logIndex}`)) ?? null
  );
}

/**
 * The widest `eth_getLogs` each side's endpoint answers. Base Sepolia's public
 * RPC refuses more than 200 blocks (measured 2026-10-19; it says so in the
 * error); Sepolia goes through Infura, which allows 10,000.
 */
const SPAN: Record<CcipSide, bigint> = { base: 200n, sepolia: 9_999n };
/** Per check, so a tab reopened after a day catches up over a few minutes. */
const CHUNKS_PER_CHECK: Record<CcipSide, number> = { base: 12, sepolia: 2 };

const clientOn = (side: CcipSide) => (side === "base" ? basePublicClient : publicClient);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** The destination chain's head, recorded before sending. */
export const destinationHead = (to: CcipSide) => clientOn(to).getBlockNumber();

let checking = false;

/**
 * Looks for the arrival of every pending transfer, a few chunks at a time,
 * and records what it finds. Returns how many arrived.
 */
export async function checkArrivals(account: Address): Promise<number> {
  if (checking) return 0;
  checking = true;
  let arrived = 0;
  try {
    for (const side of ["base", "sepolia"] as CcipSide[]) {
      const pending = read(account).filter((t) => isPending(t) && t.to === side);
      if (pending.length === 0) continue;
      const client = clientOn(side);
      const head = await client.getBlockNumber();

      for (const symbol of new Set(pending.map((t) => t.symbol))) {
        const token = tokenOn(side, symbol);
        if (!token) continue;
        const mine = pending.filter((t) => t.symbol === symbol);
        // Every pending transfer of this token shares one walk, from the
        // earliest point any of them still needs.
        let cursor = mine.reduce((m, t) => {
          const s = BigInt(t.scannedTo) + 1n;
          return s < m ? s : m;
        }, head + 1n);
        const mints: Mint[] = [];
        for (let i = 0; i < CHUNKS_PER_CHECK[side] && cursor <= head; i++) {
          const to = cursor + SPAN[side] - 1n < head ? cursor + SPAN[side] - 1n : head;
          const logs = await client.getLogs({
            address: token,
            event: transferEvent,
            args: { from: zeroAddress, to: account },
            fromBlock: cursor,
            toBlock: to,
          });
          for (const l of logs) {
            mints.push({
              hash: l.transactionHash,
              logIndex: l.logIndex,
              blockNumber: l.blockNumber,
              amount: l.args.value ?? 0n,
            });
          }
          cursor = to + 1n;
        }
        const scannedTo = cursor - 1n;

        const claimed = new Set(
          read(account)
            .filter((t) => t.arrivalHash)
            .map((t) => t.arrivalHash!),
        );
        for (const t of mine) {
          const hit = findArrival(t, mints, claimed);
          if (hit) {
            const id = `${hit.hash}:${hit.logIndex}`;
            claimed.add(id);
            let at = Date.now();
            try {
              const block = await client.getBlock({ blockNumber: hit.blockNumber });
              at = Number(block.timestamp) * 1000;
            } catch {
              /* the time we noticed is close enough */
            }
            update(account, t.hash, { arrivedAt: at, arrivalHash: id, scannedTo: hit.blockNumber.toString() });
            arrived++;
          } else if (BigInt(t.scannedTo) < scannedTo) {
            update(account, t.hash, { scannedTo: scannedTo.toString() });
          }
        }
      }
    }
  } finally {
    checking = false;
  }
  return arrived;
}

/** The destination transaction, from the `hash:logIndex` recorded on arrival. */
export const arrivalTx = (t: BridgeTransfer) => t.arrivalHash?.split(":")[0] ?? null;
