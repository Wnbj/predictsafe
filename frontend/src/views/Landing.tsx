import { REPO_URL } from "../lib/config";
import { useEffect, useMemo, useRef } from "react";
import { CATEGORIES } from "../lib/categories";
import { formatToken } from "../lib/format";
import { impliedYesPercent, totalPool } from "../lib/pricing";
import { groupIntoEvents, isLadder } from "../lib/events";
import { MarketStatus, type CategoryId, type Market, type TradeEvent } from "../lib/types";
import { MarketCard } from "../components/MarketCard";
import { Reveal } from "../components/Reveal";
import type { View } from "../lib/view";

export function Landing({
  markets,
  tradeEvents,
  onNavigate,
  onOpenMarket,
  onPickCategory,
}: {
  markets: Market[];
  tradeEvents: TradeEvent[];
  onNavigate: (v: View) => void;
  onOpenMarket: (key: string) => void;
  onPickCategory: (id: CategoryId) => void;
}) {
  const landingRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const d1 = useRef<HTMLDivElement>(null);
  const d2 = useRef<HTMLDivElement>(null);
  const d3 = useRef<HTMLDivElement>(null);
  const ringCircle = useRef<SVGCircleElement>(null);
  const ringText = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => {
    const volume = markets.reduce((a, m) => a + totalPool(m), 0n);
    const open = markets.filter((m) => m.status === MarketStatus.Open).length;
    const predictors = new Set(tradeEvents.map((e) => e.user.toLowerCase())).size;
    const resolved = markets.filter(
      (m) => m.status === MarketStatus.Settled || m.status === MarketStatus.Void,
    ).length;
    return [
      { label: "Staked to date", value: formatToken(volume) },
      { label: "Open markets", value: String(open) },
      { label: "Predictors", value: String(predictors) },
      { label: "Markets resolved", value: String(resolved) },
    ];
  }, [markets, tradeEvents]);

  // The hero ring shows the real mean implied probability across live markets.
  const avgOdds = useMemo(() => {
    const withOdds = markets
      .map(impliedYesPercent)
      .filter((p): p is number => p !== null);
    if (withOdds.length === 0) return 0;
    return Math.round(withOdds.reduce((a, b) => a + b, 0) / withOdds.length);
  }, [markets]);

  /**
   * Grouped before ranking, so a five-rung ladder competes for a slot as one
   * question rather than filling the whole row with near-identical cards —
   * the same collapsing the markets list does.
   */
  const trending = useMemo(
    () =>
      groupIntoEvents(markets)
        .map((event) => ({
          event,
          size: event.rungs.reduce((a, m) => a + totalPool(m), 0n),
        }))
        .sort((a, b) => (b.size > a.size ? 1 : b.size < a.size ? -1 : 0))
        .slice(0, 3),
    [markets],
  );

  // The mockup drove the ring from scroll position, which would park it at a
  // false "0%" until the user scrolls. It shows a real figure, so it animates
  // to that figure once on mount instead.
  useEffect(() => {
    const circle = ringCircle.current;
    const text = ringText.current;
    if (!circle || !text) return;

    const C = 326.7;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const apply = (v: number) => {
      circle.setAttribute("stroke-dashoffset", String(C * (1 - v / 100)));
      text.textContent = `${Math.round(v)}%`;
    };

    if (reduceMotion) {
      apply(avgOdds);
      return;
    }

    const DURATION = 900;
    const start = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      apply(avgOdds * eased);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [avgOdds]);

  useEffect(() => {
    const update = () => {
      const landing = landingRef.current;
      if (!landing) return;
      const rect = landing.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const scrolled = -rect.top;
      const progress = Math.min(1, Math.max(0, total > 0 ? scrolled / total : 0));

      if (glowRef.current) {
        glowRef.current.style.transform = `translateY(${progress * 240}px)`;
      }
      if (d1.current)
        d1.current.style.transform = `translateY(${-progress * 140}px) rotate(${45 + progress * 90}deg)`;
      if (d2.current)
        d2.current.style.transform = `translateY(${-progress * 90}px) rotate(${45 - progress * 60}deg)`;
      if (d3.current)
        d3.current.style.transform = `translateY(${-progress * 200}px) rotate(${45 + progress * 120}deg)`;
    };

    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => window.removeEventListener("scroll", update);
  }, [avgOdds]);

  return (
    <div ref={landingRef}>
      <div style={{ position: "relative", overflow: "hidden", padding: "88px var(--page-x) 72px" }}>
        <div
          ref={glowRef}
          style={{
            position: "absolute",
            top: -160,
            left: -80,
            width: 520,
            height: 520,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div ref={d1} style={diamond(64, "60%", 14, "var(--color-accent)", 0.5)} />
        <div ref={d2} style={diamond(220, "68%", 10, "var(--color-accent-2-400)", 0.4)} />
        <div ref={d3} style={diamond(140, "76%", 8, "var(--color-accent)", 0.3)} />

        <div className="hero-ring" style={{ position: "absolute", top: 90, right: 64, width: 140, height: 140 }}>
          <svg
            viewBox="0 0 120 120"
            width="140"
            height="140"
            style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
            aria-hidden="true"
          >
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--color-neutral-800)" strokeWidth="6" />
            <circle
              ref={ringCircle}
              cx="60"
              cy="60"
              r="52"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray="327 327"
              strokeDashoffset="327"
            />
          </svg>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
            }}
          >
            <div ref={ringText} className="heading" style={{ fontSize: 26, color: "var(--color-accent)" }}>
              0%
            </div>
            <div
              className="muted"
              style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}
            >
              avg. odds
            </div>
          </div>
        </div>

        <div style={{ position: "relative", maxWidth: 680 }}>
          <div
            className="muted"
            style={{
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              marginBottom: "var(--space-3)",
            }}
          >
            Prediction markets
          </div>
          <h1
            className="heading"
            style={{
              fontSize: 56,
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              maxWidth: 620,
              margin: "0 0 var(--space-3)",
            }}
          >
            Trade on what happens next.
          </h1>
          <p style={{ fontSize: 16, opacity: 0.8, maxWidth: 520, margin: "0 0 var(--space-6)" }}>
            Markets settled by a Chainlink CRE workflow — an oracle network reads the real-world
            result and writes it on chain. Every percentage is a live probability: pooled odds on
            most markets, a quoted price on the AMM ones.
          </p>
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <button className="btn btn-accent" onClick={() => onNavigate("markets")}>
              Explore markets
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ marginLeft: 6, verticalAlign: "-2px" }}
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            <a
              className="btn"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: "none", display: "inline-block" }}
            >
              How it works
            </a>
          </div>
        </div>
      </div>

      <div
        style={{
          background: "linear-gradient(180deg, var(--color-section), var(--color-section-glow))",
          padding: "40px var(--page-x)",
        }}
      >
        <div className="grid-4" style={{ gap: "var(--space-6)", maxWidth: 1200 }}>
          {stats.map((s) => (
            <div key={s.label}>
              <div className="heading" style={{ fontSize: 32, color: "#f3f5fe" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-accent-2-300)", marginTop: 2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "56px var(--page-x) 16px" }}>
        <h3 className="heading" style={{ fontSize: 25, margin: "0 0 var(--space-4)" }}>
          Browse by category
        </h3>
        <div className="grid-4" style={{ maxWidth: 1200 }}>
          {CATEGORIES.map((c, i) => {
            const count = c.live
              ? markets.filter((m) => m.categoryId === c.id).length
              : 0;
            return (
              <Reveal key={c.id} delay={i * 60}>
                <div
                  className={`card${c.live ? " card-interactive" : ""}`}
                  style={{ opacity: c.live ? 1 : 0.55, height: "100%" }}
                  onClick={() => c.live && onPickCategory(c.id)}
                >
                  <div
                    style={{
                      margin: "calc(-1 * var(--space-3)) calc(-1 * var(--space-3)) 0",
                      height: 92,
                      borderRadius: "var(--radius-md) var(--radius-md) 0 0",
                      background:
                        "linear-gradient(160deg, var(--color-surface), var(--color-neutral-900))",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {c.icon(44)}
                  </div>
                  <span className="tag" style={c.tagStyle}>
                    {c.name}
                  </span>
                  <div className="heading" style={{ fontSize: 17 }}>
                    {c.name}
                  </div>
                  <div className="muted-strong" style={{ fontSize: 11 }}>
                    {c.live ? `${count} market${count === 1 ? "" : "s"}` : "Coming soon"}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "40px var(--page-x) 88px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: "var(--space-4)" }}>
          <h3 className="heading" style={{ fontSize: 25, margin: 0 }}>
            Most backed
          </h3>
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3s5 4.5 5 9a5 5 0 01-10 0c0-1.2.4-2 1-3 .3 1 1 1.5 1.5 1.2C10 8 9.5 6 12 3z" />
          </svg>
        </div>

        {trending.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid-3" style={{ maxWidth: 1200 }}>
            {trending.map(({ event }, i) => (
              <Reveal key={event.key} delay={i * 60}>
                <MarketCard
                  market={event.featured}
                  ladder={isLadder(event) ? event : undefined}
                  events={tradeEvents}
                  onOpen={onOpenMarket}
                />
              </Reveal>
            ))}
          </div>
        )}
      </div>

      <div className="divider" />
      <div
        className="muted"
        style={{
          padding: "24px var(--page-x) 40px",
          display: "flex",
          gap: "var(--space-6)",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12 }}>© 2026 PredictSafe · POC on Sepolia</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: "inherit", textDecoration: "none" }}
        >
          Source
        </a>
        <a
          href="https://docs.chain.link/cre"
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: "inherit", textDecoration: "none" }}
        >
          Chainlink CRE
        </a>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="heading" style={{ fontSize: 17 }}>
        No markets on chain yet
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Deploy FlightMarket and create one with the CreateAndStake script to see it here.
      </div>
    </div>
  );
}

function diamond(
  top: number,
  left: string,
  size: number,
  background: string,
  opacity: number,
): React.CSSProperties {
  return {
    position: "absolute",
    top,
    left,
    width: size,
    height: size,
    background,
    opacity,
    transform: "rotate(45deg)",
    pointerEvents: "none",
  };
}
