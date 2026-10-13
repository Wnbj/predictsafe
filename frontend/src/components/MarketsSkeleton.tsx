/**
 * The board's outline while the first read of the markets runs — only ever
 * seen on a first visit, since a returning one starts from the cached markets.
 * Shapes rather than a sentence, so the page reads as arriving, not stuck.
 */
export function MarketsSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading markets from Sepolia">
      <div className="skeleton" style={{ width: 260, height: 32, marginBottom: "var(--space-2)" }} />
      <div className="skeleton" style={{ width: 340, height: 14, marginBottom: "var(--space-6)" }} />
      <div className="grid-3" style={{ maxWidth: 1300 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card" style={{ gap: 10 }}>
            <div
              className="skeleton"
              style={{
                margin: "calc(-1 * var(--space-3)) calc(-1 * var(--space-3)) 0",
                height: 110,
                borderRadius: "var(--radius-md) var(--radius-md) 0 0",
              }}
            />
            <div className="skeleton" style={{ width: 70, height: 18 }} />
            <div className="skeleton" style={{ width: "90%", height: 16 }} />
            <div className="skeleton" style={{ width: "60%", height: 16 }} />
            <div className="skeleton" style={{ width: "100%", height: 8, marginTop: 6 }} />
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: "var(--space-4)" }}>
        Reading markets from Sepolia…
      </p>
    </div>
  );
}
