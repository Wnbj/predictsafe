import { defineChain } from "viem";
import { sepolia } from "viem/chains";

/**
 * Deployed POC addresses on Ethereum Sepolia. Override via .env.local
 * (VITE_MARKET_ADDRESS / VITE_TOKEN_ADDRESS) when you redeploy.
 */
export const FLIGHT_MARKET_ADDRESS = (import.meta.env.VITE_FLIGHT_MARKET_ADDRESS ??
  "0x09068efb21fabeac59694e01428cf438cf38e2b3") as `0x${string}`;

export const CRYPTO_MARKET_ADDRESS = (import.meta.env.VITE_CRYPTO_MARKET_ADDRESS ??
  "0x8DA11eb17D5F3f4427aA3017E95e50b132A210be") as `0x${string}`;

export const STOCK_MARKET_ADDRESS = (import.meta.env.VITE_STOCK_MARKET_ADDRESS ??
  "0x451bcdB90EC6f6F5f40B5B2578aef641e36b71ca") as `0x${string}`;

export const RESERVE_MARKET_ADDRESS = (import.meta.env.VITE_RESERVE_MARKET_ADDRESS ??
  "0xa768Be2741A0464b81606649eCa45bfF7aD4d939") as `0x${string}`;

// Redeployed 2026-08-16 for multi-LP. The previous address
// (0x21A2…4801) is single-provider and answers to `pool()`, not `poolState()`;
// its five markets are settled and drained, so nothing is stranded there.
export const AMM_MARKET_ADDRESS = (import.meta.env.VITE_AMM_MARKET_ADDRESS ??
  "0xc9961096dc98eE17eD28bB417BB726F1b64f84FF") as `0x${string}`;

export const TOKEN_ADDRESS = (import.meta.env.VITE_TOKEN_ADDRESS ??
  "0xcd123a8d74ef062dddd2287e87bc88eb3b208b54") as `0x${string}`;

export const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * Block the contracts were deployed in. Event scans start here instead of 0 —
 * public RPCs cap getLogs ranges, and there is nothing to find before this.
 */
export const DEPLOY_BLOCK = BigInt(
  import.meta.env.VITE_DEPLOY_BLOCK ?? "11489414",
);

export const chain = defineChain({
  ...sepolia,
  rpcUrls: { default: { http: [RPC_URL] } },
});

/**
 * The KeystoneForwarder that delivers reports to our receivers.
 *
 * Overridable because it is not a fixed property of the system: this address is
 * the MockKeystoneForwarder that `cre workflow simulate --broadcast` calls, and
 * it changes when reports start arriving from a real DON. It is also shared
 * with other people's workflows on Sepolia, so anything reading its logs must
 * filter by receiver rather than assume every report is ours.
 */
export const FORWARDER_ADDRESS = (import.meta.env.VITE_FORWARDER_ADDRESS ??
  "0x15fC6ae953E024d975e77382eEeC56A9101f9F88") as `0x${string}`;

/**
 * How a report delivered by a given forwarder was attested.
 *
 * Derived from the forwarder address rather than declared next to it. The two
 * used to be independent switches — `VITE_FORWARDER_ADDRESS` decided which
 * contract's logs the app read, and a separate `VITE_DON_DEPLOYED` decided what
 * it claimed about them — so nothing stopped the app from watching the real
 * forwarder while still saying "mock", or the reverse. This is the one place
 * the app could lie about its own trust model, so the claim now follows the
 * address it is actually reading.
 *
 * An unrecognised address says exactly that. Guessing either story for an
 * unknown forwarder would reintroduce the problem in a quieter form.
 */
export const MOCK_FORWARDER = "0x15fc6ae953e024d975e77382eeec56a9101f9f88";
export const DON_FORWARDER = "0xf8344cfd5c43616a4366c34e3eee75af79a74482";

export function attestationFor(forwarder: string): string {
  switch (forwarder.toLowerCase()) {
    case DON_FORWARDER:
      return "Delivered through the Chainlink CRE forwarder and signed by the DON.";
    case MOCK_FORWARDER:
      return (
        "Delivered through the mock forwarder by `cre workflow simulate --broadcast` — " +
        "one local execution, not DON consensus. The write and the receiver's checks are real."
      );
    default:
      return (
        `Delivered through an unrecognised forwarder (${forwarder}). ` +
        "How this report was attested cannot be stated from the address alone."
      );
  }
}

/**
 * What the UI is allowed to say about how settlements here were attested.
 *
 * One value, used everywhere the question comes up, because a half-changed
 * answer is worse than either answer.
 */
/**
 * Every forwarder whose reports might be ours.
 *
 * The live feed used to read one — whichever `VITE_FORWARDER_ADDRESS` named —
 * which is right until the day both are delivering. During a migration to a
 * real DON the old mock keeps whatever is already in flight while new reports
 * arrive from the production forwarder, and a feed watching one address would
 * show half the story with no sign that it was half.
 *
 * Reports are attributed per address rather than by this list, so a settlement
 * carries the claim belonging to the forwarder that actually delivered it.
 */
export const KNOWN_FORWARDERS = [
  ...new Set([FORWARDER_ADDRESS.toLowerCase(), MOCK_FORWARDER, DON_FORWARDER]),
] as `0x${string}`[];

export const ATTESTATION_LABEL = attestationFor(FORWARDER_ADDRESS);

/**
 * Where the source lives. One constant because the repository has been renamed
 * once already, and the two links on the landing page were two separate
 * strings that happened to agree.
 */
export const REPO_URL = "https://github.com/Wnbj/predictsafe";

export const EXPLORER = "https://sepolia.etherscan.io";

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER}/address/${addr}`;
export const blockUrl = (block: bigint) => `${EXPLORER}/block/${block}`;

/** MockUSDC is 6-decimal, like real USDC. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "mUSDC";
