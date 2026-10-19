import { beforeEach, describe, expect, it } from "vitest";
import { findArrival, findSellOrder, isPending, recordTransfer, subscribeTransfers, transfersFor, type BridgeTransfer, type Mint } from "./transfers";

/**
 * A CCIP transfer outlives the page that sent it. What matters: it survives a
 * reload, it is the same list for every component showing it, and its arrival
 * is the destination's mint of exactly that amount — after it was sent, and
 * never a mint already credited to another transfer.
 */

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const transfer = (over: Partial<BridgeTransfer> = {}): BridgeTransfer => ({
  hash: "0xaa",
  from: "sepolia",
  to: "base",
  symbol: "sXAU",
  amount: "26328704716515004",
  sentAt: 1_000,
  destFromBlock: "100",
  scannedTo: "100",
  ...over,
});

const mint = (blockNumber: bigint, amount: bigint, hash = `0x${blockNumber}`, logIndex = 0): Mint => ({
  hash,
  logIndex,
  blockNumber,
  amount,
});

describe("the transfer record", () => {
  // Every test uses its own wallet: the record is cached per wallet in memory,
  // exactly as it is for the page.
  it("keeps a transfer per wallet, newest first, case-blind on the address", () => {
    recordTransfer("0xAbC1", transfer({ hash: "0x01" }));
    recordTransfer("0xabc1", transfer({ hash: "0x02" }));
    expect(transfersFor("0xABC1").map((t) => t.hash)).toEqual(["0x02", "0x01"]);
    expect(transfersFor("0xother1")).toEqual([]);
  });

  it("writes through to storage, so a reload finds it", () => {
    recordTransfer("0xabc2", transfer());
    const raw = localStorage.getItem("predictsafe.ccip:1:0xabc2");
    expect(JSON.parse(raw!)[0].hash).toBe("0xaa");
  });

  it("records the same transaction once", () => {
    recordTransfer("0xabc3", transfer());
    recordTransfer("0xabc3", transfer({ amount: "5" }));
    expect(transfersFor("0xabc3")).toHaveLength(1);
    expect(transfersFor("0xabc3")[0]!.amount).toBe("5");
  });

  it("tells every listener, and hands back the same array until it changes", () => {
    let calls = 0;
    const off = subscribeTransfers(() => calls++);
    const before = transfersFor("0xabc4");
    expect(transfersFor("0xabc4")).toBe(before);
    recordTransfer("0xabc4", transfer());
    expect(calls).toBe(1);
    expect(transfersFor("0xabc4")).not.toBe(before);
    off();
  });

  it("is pending until it has an arrival time", () => {
    expect(isPending(transfer())).toBe(true);
    expect(isPending(transfer({ arrivedAt: 5 }))).toBe(false);
  });
});

describe("findArrival", () => {
  const amount = 26328704716515004n;

  it("is the mint of exactly the amount, after the block it was sent at", () => {
    const hit = findArrival(transfer(), [mint(90n, amount), mint(150n, amount - 1n), mint(160n, amount)], new Set());
    expect(hit?.blockNumber).toBe(160n);
  });

  it("is nothing while no such mint exists", () => {
    expect(findArrival(transfer(), [mint(150n, 1n)], new Set())).toBeNull();
  });

  it("skips a mint already credited, so two equal transfers take one each, in order", () => {
    const mints = [mint(170n, amount, "0xb"), mint(160n, amount, "0xa")];
    const first = findArrival(transfer(), mints, new Set());
    expect(first?.hash).toBe("0xa");
    const second = findArrival(transfer({ hash: "0xbb" }), mints, new Set(["0xa:0"]));
    expect(second?.hash).toBe("0xb");
  });

  it("does not take an exchange fill from before the send for the arrival", () => {
    // Sepolia mints the same token when an order fills. One before the send
    // with the same amount must not end a transfer that has not landed.
    expect(findArrival(transfer({ destFromBlock: "200" }), [mint(150n, amount)], new Set())).toBeNull();
  });
});

describe("findSellOrder", () => {
  const me = "0x00000000000000000000000000000000000a11ce";
  const sale = transfer({ kind: "sell", amount: "500", sentAt: 1_000_000 });
  const order = (id: number, over: Partial<{ trader: string; side: "buy" | "sell"; amountIn: bigint; placedAt: number }> = {}) => ({
    id,
    trader: me,
    side: "sell" as const,
    amountIn: 500n,
    placedAt: 1_000 + 900, // fifteen minutes after sending, in seconds
    ...over,
  });

  it("is this wallet's sell of exactly the amount, placed after sending", () => {
    expect(findSellOrder(sale, me, [order(1)], new Set())?.id).toBe(1);
  });

  it("ignores buys, other wallets, other amounts and orders from before the send", () => {
    const others = [
      order(1, { side: "buy" }),
      order(2, { trader: "0x00000000000000000000000000000000000000b0" }),
      order(3, { amountIn: 499n }),
      order(4, { placedAt: 100 }),
    ];
    expect(findSellOrder(sale, me, others, new Set())).toBeNull();
  });

  it("skips an order already credited to another sale", () => {
    expect(findSellOrder(sale, me, [order(1), order(2)], new Set([1]))?.id).toBe(2);
  });
});
