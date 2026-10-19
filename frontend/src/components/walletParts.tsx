import { formatUnits } from "viem";
import { CCIP_CHAINS, type CcipSide } from "../lib/ccip";

/** The two chains' colours: Ethereum's slate and Base's blue. */
const CHAIN_DOT: Record<CcipSide, string> = { sepolia: "#8a93b8", base: "#3d7bff" };
const CHAIN_SHORT: Record<CcipSide, string> = { sepolia: "Sepolia", base: "Base" };

export function ChainBadge({ side, short }: { side: CcipSide; short?: boolean }) {
  return (
    <span className="chain-badge" title={CCIP_CHAINS[side].name}>
      <span className="chain-dot" style={{ background: CHAIN_DOT[side] }} />
      {short ? CHAIN_SHORT[side] : CCIP_CHAINS[side].name}
    </span>
  );
}

/** An mUSDC amount (6 decimals) as dollars, always to the cent. */
export function formatDollars(v: bigint): string {
  const n = Number(formatUnits(v, 6));
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** An 18-decimal token amount, to six places — and never a bare 0 for dust. */
export function formatUnitsShort(v: bigint): string {
  if (v === 0n) return "0";
  const n = Number(formatUnits(v, 18));
  if (n < 0.000001) return "<0.000001";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
