import { useEffect, useRef } from "react";

/**
 * Shown when a wallet has not answered for a while. The wallet's window is the
 * usual cause: behind a full-screen browser, on another desktop, or closed —
 * and a closed one never tells the page, so only the person can end the wait.
 */
export function WalletStalled({ onStop }: { onStop: () => void }) {
  // It appears near the bottom of a dialog that scrolls on a short screen.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div ref={ref} className="wallet-stalled" role="status">
      <div>
        <b>No answer from your wallet yet.</b> Its window may be hidden behind this one: click the wallet's icon in
        the browser toolbar. If you closed it, nothing was sent.
      </div>
      <button className="btn" onClick={onStop}>
        Stop waiting
      </button>
    </div>
  );
}

/** What to say after the person stops waiting: the request may still be open in the wallet. */
export const STOPPED_WAITING =
  "Stopped waiting. If the request is still open in your wallet, reject it there — confirming it would still send.";
