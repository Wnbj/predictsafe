import { isAmm } from "../lib/types";
import { useMemo } from "react";
import type { Market, TradeEvent } from "../lib/types";
import { impliedYesPercent } from "../lib/pricing";

/**
 * Implied-probability history over this market's own trades, in block order.
 *
 * Parimutuel markets are replayed from their pool ratio; AMM markets are read
 * from the price each trade actually executed at. The mockup showed a smooth price curve; a parimutuel
 * market only moves when someone stakes, so this is a step series and will look
 * sparse until a market has real activity. That sparseness is the truth — it is
 * not padded with synthetic points.
 */
export function Sparkline({
  market,
  events,
  height = 36,
  strokeWidth = 2,
}: {
  market: Market;
  events: TradeEvent[];
  height?: number;
  strokeWidth?: number;
}) {
  const points = useMemo(() => {
    const mine = events
      .filter((e) => e.marketKey === market.key)
      .sort((a, b) => Number(a.blockNumber - b.blockNumber));

    const series: number[] = [];

    // An AMM trade carries the price it executed at — collateral over shares —
    // so its history is a tape of real prices rather than a pool ratio
    // replayed. Using the parimutuel replay here would plot the sum of money
    // traded, which is not a probability at all.
    if (isAmm(market)) {
      for (const e of mine) {
        if (!e.amm || e.amm.shares === 0n) continue;
        /**
         * NET of the fee. Using the gross amount inflates the implied
         * probability by roughly the fee — and because a NO trade is plotted
         * as `100 - p`, the two sides would drift in OPPOSITE directions,
         * making the tape internally inconsistent rather than merely offset.
         */
        const net =
          e.amm.direction === "buy" ? e.amount - e.amm.fee : e.amount + e.amm.fee;
        const paidPerShare = Number((net * 10000n) / e.amm.shares) / 100;
        // A NO trade at 30c is the same information as YES at 70c.
        series.push(Math.max(0, Math.min(100, e.isYes ? paidPerShare : 100 - paidPerShare)));
      }
    } else {
      let yes = 0n;
      let no = 0n;
      for (const e of mine) {
        if (e.isYes) yes += e.amount;
        else no += e.amount;
        const total = yes + no;
        series.push(total === 0n ? 50 : Number((yes * 10000n) / total) / 100);
      }
    }

    if (series.length === 0) {
      const current = impliedYesPercent(market);
      return current === null ? [] : [current, current];
    }
    if (series.length === 1) return [series[0], series[0]];
    return series;
  }, [market, events]);

  if (points.length === 0) {
    return (
      <div
        style={{ height, display: "flex", alignItems: "center", fontSize: 11 }}
        className="muted-strong"
      >
        No trades yet
      </div>
    );
  }

  // SVG y grows downward: a higher probability should sit higher on screen.
  const coords = points
    .map((p, i) => {
      const x = points.length === 1 ? 0 : (i / (points.length - 1)) * 100;
      const y = 29 - (Math.max(0, Math.min(100, p)) / 100) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox="0 0 100 30"
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
