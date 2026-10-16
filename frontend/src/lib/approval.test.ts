import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

/**
 * The three ways a spend gets its approval. What matters is how many times the
 * user is asked, and how much is left approved afterwards.
 */

const sent: { functionName: string; args: readonly unknown[] }[] = [];

vi.mock("./chain", async (importOriginal) => {
  const real = await importOriginal<typeof import("./chain")>();
  return {
    ...real,
    walletClientOn: () => ({
      writeContract: async (p: { functionName: string; args: readonly unknown[] }) => {
        sent.push({ functionName: p.functionName, args: p.args });
        return `0x${String(sent.length).padStart(64, "0")}`;
      },
    }),
    waitForTx: async () => ({ status: "success" }),
  };
});

const { setActiveProvider } = await import("./providers");
const { ALLOWANCE_HEADROOM, writeWithApproval } = await import("./approval");
const { stakeCall } = await import("./chain");
const { crypto0 } = await import("./fixtures");

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as Address;
const SPENDER = crypto0.contract;
const AMOUNT = 5_000_000n; // 5 mUSDC

let requests: { method: string; params: unknown }[] = [];

function wallet(batch: boolean) {
  requests = [];
  setActiveProvider({
    request: async ({ method, params }: { method: string; params: unknown }) => {
      requests.push({ method, params });
      if (method === "wallet_getCapabilities")
        return { "0xaa36a7": { atomic: { status: batch ? "supported" : "unsupported" } } };
      if (method === "wallet_sendCalls") return { id: "batch-1" };
      if (method === "wallet_getCallsStatus")
        return { status: 200, receipts: [{ transactionHash: `0x${"ab".repeat(32)}` }] };
      throw new Error(`unexpected ${method}`);
    },
    on() {},
    removeListener() {},
  } as never);
}

beforeEach(() => {
  sent.length = 0;
});

describe("writeWithApproval", () => {
  it("sends only the call when the allowance already covers it", async () => {
    wallet(true);
    await writeWithApproval({
      account: ACCOUNT, spender: SPENDER, amount: AMOUNT, allowance: AMOUNT,
      call: stakeCall(crypto0, true, AMOUNT), label: "Trade",
    });
    expect(sent.map((s) => s.functionName)).toEqual(["stake"]);
    expect(requests.some((r) => r.method === "wallet_sendCalls")).toBe(false);
  });

  it("batches an exact approval with the call into one request when the wallet can", async () => {
    // A fresh account, so the capability cache from other tests does not apply.
    const account = "0x00000000000000000000000000000000000b0b00" as Address;
    wallet(true);
    await writeWithApproval({
      account, spender: SPENDER, amount: AMOUNT, allowance: 0n,
      call: stakeCall(crypto0, true, AMOUNT), label: "Trade",
    });
    expect(sent).toEqual([]); // nothing went through writeContract
    const batch = requests.find((r) => r.method === "wallet_sendCalls")!.params as [
      { calls: { to: string; data: string }[]; atomicRequired: boolean },
    ];
    expect(batch[0].atomicRequired).toBe(true);
    expect(batch[0].calls).toHaveLength(2);
    // approve(spender, EXACTLY the amount) — 0x095ea7b3 is approve's selector.
    expect(batch[0].calls[0]!.data.startsWith("0x095ea7b3")).toBe(true);
    expect(batch[0].calls[0]!.data.endsWith(AMOUNT.toString(16).padStart(64, "0"))).toBe(true);
  });

  it("without batching, approves at least the headroom, then sends the call", async () => {
    const account = "0x0000000000000000000000000000000000c0ffee" as Address;
    wallet(false);
    await writeWithApproval({
      account, spender: SPENDER, amount: AMOUNT, allowance: 0n,
      call: stakeCall(crypto0, true, AMOUNT), label: "Trade",
    });
    expect(sent.map((s) => s.functionName)).toEqual(["approve", "stake"]);
    expect(sent[0]!.args).toEqual([SPENDER, ALLOWANCE_HEADROOM]);
  });

  it("approves the amount itself when it is larger than the headroom", async () => {
    const account = "0x0000000000000000000000000000000000d00d00" as Address;
    wallet(false);
    const big = ALLOWANCE_HEADROOM + 1n;
    await writeWithApproval({
      account, spender: SPENDER, amount: big, allowance: 0n,
      call: stakeCall(crypto0, true, big), label: "Trade",
    });
    expect(sent[0]!.args).toEqual([SPENDER, big]);
  });
});
