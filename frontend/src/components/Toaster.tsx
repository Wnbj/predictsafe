import { dismissToast, useToasts, type ToastState } from "../lib/toasts";

const ACCENT: Record<ToastState, string> = {
  pending: "var(--color-accent)",
  success: "var(--color-accent-300)",
  error: "var(--color-negative)",
};

const ICON: Record<ToastState, string> = { pending: "◌", success: "✓", error: "!" };

/** Bottom-right on a desk, full-width at the bottom on a phone. */
export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" style={{ borderLeftColor: ACCENT[t.state] }}>
          <span
            aria-hidden="true"
            className={t.state === "pending" ? "toast-spin" : undefined}
            style={{ color: ACCENT[t.state], fontWeight: 700, width: 14, textAlign: "center" }}
          >
            {ICON[t.state]}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
            {t.detail && (
              <div className="muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                {t.detail}
              </div>
            )}
            {t.href && (
              <a href={t.href} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                View on Etherscan ↗
              </a>
            )}
          </div>
          <button
            className="linklike muted"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
            style={{ fontSize: 14, alignSelf: "flex-start" }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
