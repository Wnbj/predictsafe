import { useEffect, useRef, useState } from "react";
import {
  addressUrl,
  EXCHANGE_TOKENS,
  SEPOLIA_FAUCET_URL,
  TOKEN_ADDRESS,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
} from "../lib/config";
import { sendMint, waitForTx, watchToken } from "../lib/chain";
import type { Address } from "viem";
import { formatToken, initials, shortAddress } from "../lib/format";
import type { WalletState } from "../hooks/useWallet";
import type { View } from "../lib/view";

const LINKS: { view: View; label: string }[] = [
  { view: "markets", label: "Markets" },
  { view: "trade", label: "Trade" },
  { view: "portfolio", label: "Portfolio" },
  { view: "leaderboard", label: "Leaderboard" },
  { view: "live", label: "Live" },
];

export function Nav({
  view,
  onNavigate,
  wallet,
  balance,
  onBalanceChange,
}: {
  view: View;
  onNavigate: (v: View) => void;
  wallet: WalletState;
  balance: bigint;
  /** After a faucet mint, so the balance beside the menu catches up. */
  onBalanceChange: () => Promise<void>;
}) {
  const isActive = (v: View) =>
    v === "markets" ? view === "markets" || view === "detail" : view === v;
  // Phones only (CSS decides): five links and a wallet button wrapped onto two
  // rows of a sticky bar, eating a fifth of a small screen on every page.
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (v: View) => {
    setMenuOpen(false);
    onNavigate(v);
  };
  const link = (l: { view: View; label: string }) => (
    <a
      key={l.view}
      href="#"
      onClick={(e) => {
        e.preventDefault();
        go(l.view);
      }}
      aria-current={isActive(l.view) ? "page" : undefined}
      style={{
        fontSize: 14,
        textDecoration: "none",
        color: isActive(l.view) ? "var(--color-accent)" : "var(--color-text)",
      }}
    >
      {l.label}
    </a>
  );

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4)",
          padding: "8.4px var(--page-x)",
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: "var(--color-bg)",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}
          onClick={() => go("landing")}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="22"
              height="22"
              rx="6"
              stroke="var(--color-accent)"
              strokeWidth="1.6"
            />
            <path
              d="M7 15l4-4 3 3 4-6"
              stroke="var(--color-accent)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="heading" style={{ fontSize: 18 }}>
            PredictSafe
          </span>
        </div>

        <nav className="nav-links">{LINKS.map(link)}</nav>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-4)",
            flexWrap: "wrap",
          }}
        >
          {wallet.account && (
            <div
              className="muted nav-balance"
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}
              title={`${TOKEN_SYMBOL} balance`}
            >
              <WalletIcon />
              <span style={{ color: "var(--color-text)" }}>{formatToken(balance)}</span>
            </div>
          )}

          {wallet.account ? (
            <AccountMenu
              account={wallet.account}
              onDisconnect={wallet.disconnect}
              onBalanceChange={onBalanceChange}
            />
          ) : (
            <ConnectControl wallet={wallet} />
          )}
          <button
            className="nav-burger"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {menuOpen && <nav className="nav-drawer">{LINKS.map(link)}</nav>}

      <div className="divider" />

      {wallet.wrongNetwork && (
        <Banner>
          Wrong network — this app runs on Sepolia.{" "}
          <button
            className="btn btn-accent"
            style={{ padding: "4px 10px", fontSize: 13, marginLeft: 8 }}
            onClick={() => void wallet.switchNetwork()}
          >
            Switch to Sepolia
          </button>
        </Banner>
      )}

      {wallet.error && <Banner tone="error">{wallet.error}</Banner>}
    </>
  );
}

/**
 * With several wallet extensions installed there is no safe guess about which
 * one the user means — `window.ethereum` is whichever won the race, not their
 * choice. So more than one discovered wallet gets a picker.
 */
function ConnectControl({ wallet }: { wallet: WalletState }) {
  // Lives in the wallet hook, so a Connect button anywhere on the page can
  // open this picker rather than silently doing nothing.
  const open = wallet.pickerOpen;
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) =>
    wallet.setPickerOpen(typeof v === "function" ? v(wallet.pickerOpen) : v);
  const ref = useRef<HTMLDivElement>(null);

  const setPickerOpen = wallet.setPickerOpen;
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickerOpen(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setPickerOpen]);

  const many = wallet.wallets.length > 1;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn btn-accent"
        onClick={() => {
          if (many) setOpen((v) => !v);
          else void wallet.connect();
        }}
        aria-haspopup={many ? "menu" : undefined}
        aria-expanded={many ? open : undefined}
      >
        Connect wallet
      </button>

      {open && many && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            minWidth: 208,
            padding: "var(--space-2)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-surface)",
            boxShadow: "var(--shadow-md)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            zIndex: 30,
          }}
        >
          <div className="muted-strong" style={{ fontSize: 11, padding: "4px 8px" }}>
            Choose a wallet
          </div>
          {wallet.wallets.map((w) => (
            <button
              key={w.info.uuid}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void wallet.connect(w);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                fontSize: 13,
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                border: "none",
                color: "var(--color-text)",
                cursor: "pointer",
              }}
            >
              <img src={w.info.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />
              {w.info.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu({
  account,
  onDisconnect,
  onBalanceChange,
}: {
  account: Address;
  onDisconnect: () => Promise<void>;
  onBalanceChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  /** What the last faucet or add-token action did, shown in the menu. */
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The two things a newcomer gets stuck on before their first trade: no
  // test money, and tokens their wallet does not list. Both used to live only
  // inside individual panels, or nowhere.
  const mint = async () => {
    setBusy(true);
    setNote("Confirm in wallet…");
    try {
      const hash = await sendMint(account, 100n * 10n ** BigInt(TOKEN_DECIMALS));
      setNote("Minting…");
      await waitForTx(hash, `Test ${TOKEN_SYMBOL}`);
      await onBalanceChange();
      setNote(`Added 100 ${TOKEN_SYMBOL}.`);
    } catch (e) {
      setNote(/User rejected|denied/i.test(String(e)) ? "Cancelled." : "Mint failed — is the wallet on Sepolia?");
    } finally {
      setBusy(false);
    }
  };

  const addTokens = async () => {
    setBusy(true);
    const tokens = [
      { address: TOKEN_ADDRESS, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
      ...EXCHANGE_TOKENS,
    ];
    const added: string[] = [];
    for (const t of tokens) {
      setNote(`Approve ${t.symbol} in your wallet…`);
      if (await watchToken(t)) added.push(t.symbol);
    }
    setNote(added.length ? `Added ${added.join(", ")}.` : "Your wallet did not add any.");
    setBusy(false);
  };
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={account}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          background: "transparent",
          border: "1px solid var(--color-divider)",
          borderRadius: "var(--radius-md)",
          padding: "3px 6px 3px 10px",
          color: "var(--color-text)",
          fontSize: 13,
        }}
      >
        <span className="muted">{shortAddress(account)}</span>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: "var(--color-accent-800)",
            color: "var(--color-accent-100)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {initials(account)}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            minWidth: 232,
            padding: "var(--space-2)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-surface)",
            boxShadow: "var(--shadow-md)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            zIndex: 30,
          }}
        >
          <div
            className="muted-strong"
            style={{ fontSize: 11, padding: "4px 8px", wordBreak: "break-all" }}
          >
            {account}
          </div>
          <a
            href={addressUrl(account)}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            style={menuItemStyle}
            onClick={() => setOpen(false)}
          >
            View on Etherscan ↗
          </a>
          <div style={{ height: 1, background: "var(--color-divider)", margin: "4px 0" }} />
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => void mint()}
            style={{ ...menuItemStyle, border: "none", width: "100%", textAlign: "left" }}
          >
            Get 100 test {TOKEN_SYMBOL}
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => void addTokens()}
            style={{ ...menuItemStyle, border: "none", width: "100%", textAlign: "left" }}
            title={`${TOKEN_SYMBOL}, ${EXCHANGE_TOKENS.map((t) => t.symbol).join(", ")}`}
          >
            Add tokens to wallet
          </button>
          <a
            href={SEPOLIA_FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            style={menuItemStyle}
          >
            Sepolia ETH for gas ↗
          </a>
          {note && (
            <div className="muted" style={{ fontSize: 12, padding: "4px 8px" }} role="status">
              {note}
            </div>
          )}
          <div style={{ height: 1, background: "var(--color-divider)", margin: "4px 0" }} />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onDisconnect();
            }}
            style={{ ...menuItemStyle, border: "none", width: "100%", textAlign: "left" }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-text)",
  textDecoration: "none",
  cursor: "pointer",
  display: "block",
};

function Banner({
  children,
  tone = "warn",
}: {
  children: React.ReactNode;
  tone?: "warn" | "error";
}) {
  return (
    <div
      style={{
        padding: "10px var(--page-x)",
        fontSize: 13,
        background:
          tone === "error"
            ? "color-mix(in srgb, var(--color-negative) 12%, transparent)"
            : "color-mix(in srgb, var(--color-accent) 12%, transparent)",
        color: tone === "error" ? "var(--color-negative)" : "var(--color-accent-200)",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {children}
    </div>
  );
}

function WalletIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
      <path d="M2.5 9.5h19" />
      <circle cx="17" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
