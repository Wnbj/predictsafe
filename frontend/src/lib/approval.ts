import { encodeFunctionData, type Abi, type Address } from "viem";
import { approveCall, SEPOLIA_NETWORK, waitForTx, walletClientOn, type ContractCall, type TxNetwork } from "./chain";
import { TOKEN_ADDRESS, TOKEN_DECIMALS, TOKEN_SYMBOL } from "./config";
import { getActiveProvider } from "./providers";
import { dismissToast, showToast } from "./toasts";

/**
 * A write that spends mUSDC, with the approval it needs — in ONE confirmation
 * where the wallet allows it.
 *
 * ERC-20 makes spending a two-step: `approve` lets the contract pull the
 * tokens, then the call pulls them. Approving exactly the amount is the safe
 * default and was this app's only path, so every stake asked the wallet twice.
 *
 * In order of preference:
 *  1. enough allowance already — just the call;
 *  2. the wallet can batch (EIP-5792 `wallet_sendCalls`, e.g. MetaMask on a
 *     smart account) — approve EXACTLY the amount and the call together, one
 *     confirmation, nothing left approved afterwards;
 *  3. otherwise two confirmations, but the approval covers at least
 *     ALLOWANCE_HEADROOM so the next few stakes need only one. The amount is
 *     stated where the user sees it, never "unlimited".
 */

export const ALLOWANCE_HEADROOM = 1_000n * 10n ** BigInt(TOKEN_DECIMALS);

export const headroomLabel = `${ALLOWANCE_HEADROOM / 10n ** BigInt(TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`;

type Capabilities = Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }>;

const batchSupport = new Map<string, boolean>();

const hexId = (id: number) => `0x${id.toString(16)}`;

/** Whether the connected wallet will run several calls as one, atomically, on `chainId`. */
export async function canBatch(account: Address, chainId: number = SEPOLIA_NETWORK.chain.id): Promise<boolean> {
  const CHAIN_HEX = hexId(chainId);
  const key = `${account.toLowerCase()}:${chainId}`;
  const known = batchSupport.get(key);
  if (known !== undefined) return known;
  const provider = getActiveProvider();
  let ok = false;
  if (provider) {
    try {
      const caps = (await provider.request({
        method: "wallet_getCapabilities",
        params: [account, [CHAIN_HEX]],
      } as never)) as Capabilities;
      const c = caps?.[CHAIN_HEX] ?? caps?.[String(chainId)];
      // "ready" means the wallet can upgrade the account to batch on the spot
      // and will ask the user itself; "supported" means it already can. The
      // atomicBatch shape is the draft MetaMask shipped first.
      ok = c?.atomic?.status === "supported" || c?.atomic?.status === "ready" || c?.atomicBatch?.supported === true;
    } catch {
      ok = false;
    }
  }
  batchSupport.set(key, ok);
  return ok;
}

const encode = (c: ContractCall) => ({
  to: c.address,
  data: encodeFunctionData({ abi: c.abi as Abi, functionName: c.functionName, args: c.args as never }),
  value: `0x${(c.value ?? 0n).toString(16)}`,
});

/** Polls `wallet_getCallsStatus` until the batch is mined; returns its last tx. */
async function waitForBatch(id: string): Promise<`0x${string}`> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet connected");
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const s = (await provider.request({ method: "wallet_getCallsStatus", params: [id] } as never)) as {
      status: number | string;
      receipts?: { transactionHash: `0x${string}`; status?: string }[];
    };
    const done = s.status === 200 || s.status === "CONFIRMED";
    const failed = typeof s.status === "number" && s.status >= 400;
    if (failed) throw new Error("The wallet reports the batch failed.");
    if (done) {
      const last = s.receipts?.at(-1)?.transactionHash;
      if (!last) throw new Error("The batch confirmed without a transaction hash.");
      return last;
    }
    if (Date.now() > deadline) throw new Error("No confirmation from the wallet after five minutes.");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export interface ApprovedWrite {
  account: Address;
  /** The contract that will pull the tokens. */
  spender: Address;
  /** What this call spends. */
  amount: bigint;
  /** The spender's current allowance from `account`. */
  allowance: bigint;
  call: ContractCall;
  /** For the notices: "Trade", "Liquidity deposit", "Order". */
  label: string;
  /** Called when a separate approval step starts, for a panel's busy state. */
  onApproving?: () => void;
  /** The token being spent. Defaults to mUSDC. */
  token?: Address;
  /** The chain it all happens on. Defaults to Sepolia. */
  network?: TxNetwork;
  /** Called once the wallet has signed the call and it is only waiting for a block. */
  onSubmitted?: () => void;
}

/** Sends the call, approving first if needed; resolves once it is confirmed. */
export async function writeWithApproval(w: ApprovedWrite): Promise<`0x${string}`> {
  const network = w.network ?? SEPOLIA_NETWORK;
  const token = w.token ?? TOKEN_ADDRESS;
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet connected");
  const wallet = walletClientOn(w.account, network.chain);
  const send = (c: ContractCall) =>
    wallet.writeContract({
      address: c.address,
      abi: c.abi as Abi,
      functionName: c.functionName,
      args: c.args,
      value: c.value,
      chain: network.chain,
      account: w.account,
    } as never) as Promise<`0x${string}`>;

  if (w.allowance >= w.amount) {
    const hash = await send(w.call);
    w.onSubmitted?.();
    await waitForTx(hash, w.label, network);
    return hash;
  }

  if (await canBatch(w.account, network.chain.id)) {
    const CHAIN_HEX = hexId(network.chain.id);
    const sent = (await provider.request({
      method: "wallet_sendCalls",
      params: [
        {
          version: "2.0.0",
          chainId: CHAIN_HEX,
          from: w.account,
          atomicRequired: true,
          calls: [encode(approveCall(w.spender, w.amount, token)), encode(w.call)],
        },
      ],
    } as never)) as { id: string } | string;
    const id = typeof sent === "string" ? sent : sent.id;
    w.onSubmitted?.();
    showToast({ id, state: "pending", title: `${w.label} sent`, detail: `Approval and ${w.label.toLowerCase()} in one transaction…` });
    try {
      const hash = await waitForBatch(id);
      dismissToast(id);
      await waitForTx(hash, w.label, network); // confirms at once; also catches a revert
      return hash;
    } catch (e) {
      showToast({ id, state: "error", title: `${w.label} failed`, detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  w.onApproving?.();
  // Headroom is for mUSDC stakes, the thing people repeat. Any other token —
  // an asset sold back, a bridge transfer — is approved for exactly the amount.
  const approval = token === TOKEN_ADDRESS && w.amount < ALLOWANCE_HEADROOM ? ALLOWANCE_HEADROOM : w.amount;
  const approveHash = await send(approveCall(w.spender, approval, token));
  await waitForTx(approveHash, "Approval", network);
  const hash = await send(w.call);
  w.onSubmitted?.();
  await waitForTx(hash, w.label, network);
  return hash;
}
