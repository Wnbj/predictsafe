import { useEffect, useState } from "react";
import {
  CRYPTO_ASSETS,
  createdCryptoMarketId,
  marketKey,
  sendCreateCryptoMarket,
  type CryptoAsset,
} from "../lib/chain";
import { cryptoMarketTerms, HORIZONS, roundStrike, STRIKE_STEP } from "../lib/createMarket";
import type { WalletState } from "../hooks/useWallet";
import { formatClock, localTimes } from "../lib/format";

/**
 * Open a BTC or ETH price market from the app.
 *
 * `CryptoMarket.newMarket` is open to anyone and takes no collateral, and
 * since SettlementKeeper the market also settles with nobody watching — so
 * this is the whole lifecycle from one button. Crypto only, on purpose: it is
 * the one family whose terms a visitor can choose freely. A flight needs a
 * real flight number and date, a stock or reserve market an allowlisted feed,
 * and an AMM market seed liquidity.
 */
export function CreateMarket({
  wallet,
  onCreated,
  onClose,
}: {
  wallet: WalletState;
  onCreated: (key: string) => Promise<void>;
  onClose: () => void;
}) {
  const [asset, setAsset] = useState<CryptoAsset>("BTC");
  const [horizon, setHorizon] = useState(HORIZONS[1]!);
  const [strike, setStrike] = useState("");
  const [spot, setSpot] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "signing" | "confirming">(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // The current price, once per asset, to start the strike somewhere sensible.
  useEffect(() => {
    let live = true;
    setSpot(null);
    fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/ticker`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const p = Number(j?.price);
        if (!live || !Number.isFinite(p)) return;
        setSpot(p);
        setStrike(String(roundStrike(asset, p)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asset]);

  // Expiry is "from now", so keep the preview honest while the form is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);

  const strikeUsd = Number(strike);
  const valid = Number.isFinite(strikeUsd) && strikeUsd > 0;
  const terms = valid ? cryptoMarketTerms(asset, strikeUsd, horizon, now) : null;

  const submit = async () => {
    if (!wallet.account || !terms) return;
    setError(null);
    try {
      setBusy("signing");
      // Recomputed at the click: the preview may be a few seconds old, and a
      // close time already in the past would revert.
      const fresh = cryptoMarketTerms(asset, strikeUsd, horizon, Math.floor(Date.now() / 1000));
      const hash = await sendCreateCryptoMarket(wallet.account, { asset, ...fresh });
      setBusy("confirming");
      const id = await createdCryptoMarketId(hash);
      if (id === null) throw new Error("The transaction confirmed but no market was created.");
      await onCreated(marketKey("crypto", id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /User rejected|denied transaction/i.test(msg)
          ? "Transaction rejected in wallet."
          : /insufficient funds/i.test(msg)
            ? "Not enough Sepolia ETH for gas."
            : msg.split("\n")[0]!.slice(0, 160),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 640, marginBottom: "var(--space-6)", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="heading" style={{ fontSize: 18 }}>
          Create a price market
        </div>
        <button className="linklike muted" onClick={onClose} style={{ fontSize: 13 }}>
          Close
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Free apart from gas. It settles on its own after expiry from Coinbase, Kraken and Bitstamp
        candles — but it needs a stake on both Yes and No, or it refunds everyone.
      </div>

      <Field label="Asset">
        <div className="seg">
          {CRYPTO_ASSETS.map((a) => (
            <button key={a} className={asset === a ? "active" : ""} onClick={() => setAsset(a)}>
              {a}
            </button>
          ))}
        </div>
      </Field>

      <Field label="At or above (USD)">
        <input
          type="text"
          inputMode="decimal"
          value={strike}
          onChange={(e) => setStrike(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder={spot === null ? "…" : String(roundStrike(asset, spot))}
          style={{ width: 180 }}
        />
        {spot !== null && (
          <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
            now ${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })} · steps of $
            {STRIKE_STEP[asset]}
          </span>
        )}
      </Field>

      <Field label="Expires in">
        <div className="seg">
          {HORIZONS.map((h) => (
            <button
              key={h.label}
              className={horizon.label === h.label ? "active" : ""}
              onClick={() => setHorizon(h)}
            >
              {h.label}
            </button>
          ))}
        </div>
      </Field>

      {terms && (
        <div
          style={{
            padding: "var(--space-3)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-neutral-900)",
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{localTimes(terms.question)}</div>
          <div className="muted">
            Staking closes {Math.round(horizon.closeBefore / 60)} min before expiry, at{" "}
            {formatClock(terms.closeTime)}.
          </div>
        </div>
      )}

      {error && <div style={{ color: "var(--color-negative)", fontSize: 13 }}>{error}</div>}

      {!wallet.account ? (
        <button className="btn btn-accent" onClick={() => void wallet.connect()}>
          Connect wallet to create
        </button>
      ) : wallet.wrongNetwork ? (
        <button className="btn btn-accent" onClick={() => void wallet.switchNetwork()}>
          Switch to Sepolia
        </button>
      ) : (
        <button className="btn btn-accent" disabled={!terms || busy !== null} onClick={() => void submit()}>
          {busy === "signing"
            ? "Confirm in wallet…"
            : busy === "confirming"
              ? "Creating…"
              : "Create market"}
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="eyebrow" style={{ fontSize: 11 }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}
