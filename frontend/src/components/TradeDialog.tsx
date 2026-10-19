import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { ExchangeState, OrderSide } from "../lib/exchange";
import { TradeForm } from "./TradeForm";

/**
 * Buying and selling from the wallet, without leaving it: the Trade page's
 * order form (TradeForm) in a dialog like the CCIP Transfer one.
 */
export function TradeDialog({
  initial,
  onClose,
  ...rest
}: {
  account: Address;
  state: ExchangeState;
  usdc: { balance: bigint; allowance: bigint };
  now: number;
  initial: { side: OrderSide; assetId: number };
  baseBalances: Record<string, bigint> | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  onTransferBack: (symbol: string) => void;
}) {
  const [side, setSide] = useState<OrderSide>(initial.side);
  const [assetId, setAssetId] = useState(initial.assetId);
  const [busy, setBusy] = useState(false);

  // Escape and the backdrop close it — except while the wallet is asking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={side === "buy" ? "Buy" : "Sell"}>
        <TradeForm
          {...rest}
          side={side}
          onSide={setSide}
          assetId={assetId}
          onAssetId={setAssetId}
          onClose={onClose}
          onFinish={onClose}
          onBusy={setBusy}
        />
      </div>
    </div>
  );
}
