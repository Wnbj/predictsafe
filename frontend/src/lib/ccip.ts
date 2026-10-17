import {
  createPublicClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { publicClient, SEPOLIA_NETWORK, type ContractCall, type TxNetwork } from "./chain";
import { EXCHANGE_TOKENS } from "./config";
import { getActiveProvider } from "./providers";

/**
 * Chainlink CCIP between Ethereum Sepolia and Base Sepolia, for the exchange's
 * synthetic tokens.
 *
 * The tokens are CCIP cross-chain tokens with a burn & mint pool on each side:
 * sending burns on the source chain and the DON-attested message mints the
 * same amount on the destination. Supply across the two chains is constant, and
 * every token is still a claim on the ONE exchange reserve on Sepolia — so
 * selling means bringing it back first.
 *
 * Every address here was read from Chainlink's CCIP directory data and then
 * checked on chain (typeAndVersion, isChainSupported) on 2026-10-17.
 */

export type CcipSide = "sepolia" | "base";

/** Base Sepolia's public RPC: no key, and it answers browser origins. */
const BASE_RPC = "https://sepolia.base.org";

export const basePublicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC) });

export const BASE_NETWORK: TxNetwork = {
  name: "Base Sepolia",
  chain: baseSepolia,
  client: basePublicClient,
  txUrl: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
};

export const CCIP_CHAINS: Record<CcipSide, { name: string; selector: bigint; router: Address; network: TxNetwork }> = {
  sepolia: {
    name: "Ethereum Sepolia",
    selector: 16015286601757825753n,
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    network: SEPOLIA_NETWORK,
  },
  base: {
    name: "Base Sepolia",
    selector: 10344971235874465080n,
    router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
    network: BASE_NETWORK,
  },
};

/**
 * The same tokens on Base Sepolia, by symbol, deployed 2026-10-17 with their
 * BurnMintTokenPools (sXAU 0x409a…91E7, sCSPX 0x3b22…197B). A null here hides
 * the bridge controls rather than offer a send that cannot arrive.
 */
export const BASE_TOKENS: Record<string, Address | null> = {
  sXAU: "0xc20BFD974F374669cAC5994D1E712F03BC102242",
  sCSPX: "0x95f4f643654cf63171eD5a8d6751752Ba43793CA",
};

export const tokenOn = (side: CcipSide, symbol: string): Address | null =>
  side === "base"
    ? (BASE_TOKENS[symbol] ?? null)
    : ((EXCHANGE_TOKENS.find((t) => t.symbol === symbol)?.address as Address | undefined) ?? null);

export const bridgeReady = (symbol: string) => tokenOn("sepolia", symbol) !== null && tokenOn("base", symbol) !== null;

const routerAbi = parseAbi([
  "function getFee(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) view returns (uint256)",
  "function ccipSend(uint64 destinationChainSelector, (bytes receiver, bytes data, (address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) payable returns (bytes32)",
]);

/**
 * Tokens to `receiver` on the other chain, fee paid in the source chain's
 * native gas token (`feeToken` zero), no payload, default extra args — an
 * EOA receives tokens without running code, so no gas limit is needed for it.
 */
export function bridgeMessage(receiver: Address, token: Address, amount: bigint) {
  return {
    receiver: encodeAbiParameters([{ type: "address" }], [receiver]),
    data: "0x" as `0x${string}`,
    tokenAmounts: [{ token, amount }],
    feeToken: zeroAddress,
    extraArgs: "0x" as `0x${string}`,
  };
}

const other = (side: CcipSide): CcipSide => (side === "sepolia" ? "base" : "sepolia");
const clientOn = (side: CcipSide) => (side === "sepolia" ? publicClient : basePublicClient);

/**
 * The fee to send from `from`, plus 5%. The router keeps whatever value it is
 * sent and rejects anything short, and the quote moves with gas prices between
 * reading it and the transaction landing — a small margin beats a revert.
 */
export async function bridgeFee(from: CcipSide, receiver: Address, token: Address, amount: bigint): Promise<bigint> {
  const fee = await clientOn(from).readContract({
    address: CCIP_CHAINS[from].router,
    abi: routerAbi,
    functionName: "getFee",
    args: [CCIP_CHAINS[other(from)].selector, bridgeMessage(receiver, token, amount)],
  });
  return (fee * 105n) / 100n;
}

export function ccipSendCall(from: CcipSide, receiver: Address, token: Address, amount: bigint, fee: bigint): ContractCall {
  return {
    address: CCIP_CHAINS[from].router,
    abi: routerAbi,
    functionName: "ccipSend",
    args: [CCIP_CHAINS[other(from)].selector, bridgeMessage(receiver, token, amount)],
    value: fee,
  };
}

/** Balance and router allowance for `account` on one side. */
export async function readBridgeSide(side: CcipSide, symbol: string, account: Address) {
  const token = tokenOn(side, symbol);
  if (!token) return null;
  const client = clientOn(side);
  const [balance, allowance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, CCIP_CHAINS[side].router],
    }),
  ]);
  return { token, balance, allowance };
}

/** Where to watch a message: CCIP Explorer finds it by the source transaction. */
export const ccipExplorerTx = (hash: string) => `https://ccip.chain.link/tx/${hash}`;

/**
 * Puts the wallet on `side`'s chain, adding Base Sepolia to it if it has never
 * seen it (EIP-3085). A send from Base must be signed on Base.
 */
export async function ensureWalletOn(side: CcipSide): Promise<void> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet connected");
  const chain = CCIP_CHAINS[side].network.chain;
  const chainId = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] } as never);
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [side === "base" ? BASE_RPC : chain.rpcUrls.default.http[0]],
          blockExplorerUrls: [chain.blockExplorers?.default.url],
        },
      ],
    } as never);
  }
}
