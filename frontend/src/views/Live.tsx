import { category } from "../lib/categories";
import {
  addressUrl,
  attestationFor,
  blockUrl,
  txUrl,
} from "../lib/config";
import { formatMarketValue, formatTimestamp, formatToken, outcomeLabel, shortAddress } from "../lib/format";
import { history, inFlight, type Attempt, type PipelineState } from "../lib/pipeline";
import { SummaryCard } from "../components/SummaryCard";
import { Outcome, type LpEvent, type Market } from "../lib/types";
import { useSettlementFeed } from "../hooks/useSettlementFeed";

/**
 * The settlement pipeline, as the chain reports it.
 *
 * Nothing here is told what to show. It reads Sepolia logs on a timer, so when
 * a settlement is requested elsewhere — a terminal, a script, eventually a DON
 * — this page changes on its own a few seconds later.
 *
 * What that proves is bounded, and the page says so: it confirms a report was
 * DELIVERED AND ACCEPTED, by reading the forwarder's own verdict. It does not
 * independently check the price the workflow observed. Nothing could, from
 * chain data — the venue prices are reconciled to a median and discarded, and
 * the evidence document is hashed rather than published.
 */
export function Live({
  markets,
  lpEvents,
}: {
  markets: Market[];
  lpEvents: LpEvent[];
}) {
  const feed = useSettlementFeed(markets, lpEvents);
  const waiting = inFlight(feed);
  const done = history(feed);
  const rejected = feed.attempts.filter((a) => a.state === "rejected").length;
  /**
   * Counted explicitly rather than as `done.length`.
   *
   * `history` means "resolved", which now includes a market voided by the
   * owner with no settlement log behind it. Those belong in the table — they
   * are over, and hiding them would lose the row — but calling them settled
   * would count a settlement that never happened, on the one card whose whole
   * job is to say how many did.
   */
  const settledCount = feed.attempts.filter(
    (a) => a.state === "settled" || a.state === "settled-unattested" || a.state === "paid",
  ).length;

  return (
    <div className="page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Settlement pipeline
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)", maxWidth: 760 }}>
        Read straight from Sepolia logs, every {POLL_LABEL}. Nothing on this page is pushed to
        it — when a settlement is requested anywhere, it appears here on its own. It shows that a
        report was delivered and accepted; it does not re-check the price the workflow saw.
      </p>

      <div className="grid-4" style={{ maxWidth: 1100, marginBottom: "var(--space-6)" }}>
        <SummaryCard label="Watching" value={feed.head > 0n ? `#${feed.head}` : "—"} accent>
          <div className="muted" style={{ fontSize: 11 }}>
            {feed.lastPollAt
              ? `last read ${formatTimestamp(Math.floor(feed.lastPollAt / 1000))}`
              : "connecting…"}
          </div>
        </SummaryCard>
        <SummaryCard label="In flight" value={String(waiting.length)} />
        <SummaryCard label="Settled" value={String(settledCount)} />
        <SummaryCard
          label="Refused"
          value={String(rejected)}
          color={rejected > 0 ? "var(--color-negative)" : undefined}
        />
      </div>

      {feed.failures.length > 0 && (
        <div
          className="card"
          style={{
            maxWidth: 820,
            marginBottom: "var(--space-6)",
            color: "var(--color-negative)",
            fontSize: 13,
          }}
        >
          {feed.failures.map((f) => (
            <div key={f.family}>
              <strong>{f.family}</strong> logs could not be read — that part of every pipeline
              below is missing, not absent. {f.message.split("\n")[0]}
            </div>
          ))}
        </div>
      )}

      <section style={{ marginBottom: "var(--space-8)" }}>
        <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>
          In flight
        </div>
        {waiting.length === 0 ? (
          <div className="card" style={{ maxWidth: 520 }}>
            <div className="heading" style={{ fontSize: 17 }}>
              Nothing being settled right now
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {feed.loading
                ? "Reading the chain…"
                : "Request a settlement and this fills in by itself."}
            </div>
          </div>
        ) : (
          waiting.map((a) => <AttemptCard key={a.id} attempt={a} />)
        )}
      </section>

      {done.length > 0 && (
        <section style={{ marginBottom: "var(--space-8)" }}>
          <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>
            Settled to date
          </div>
          <div className="table-scroll">
            <table className="data" style={{ maxWidth: 1200 }}>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Requested</th>
                  <th>Report</th>
                  <th>Outcome</th>
                  <th>Observed</th>
                  <th>Gap</th>
                  <th>Payouts</th>
                </tr>
              </thead>
              <tbody>
                {done.map((a) => (
                  <HistoryRow key={a.id} attempt={a} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {feed.unattributed.length > 0 && (
        <section>
          <div className="eyebrow" style={{ marginBottom: "var(--space-3)" }}>
            Refused reports with no market named
          </div>
          <div className="card" style={{ maxWidth: 820 }}>
            <div className="muted" style={{ fontSize: 13, marginBottom: "var(--space-2)" }}>
              A report names the contract it was delivered to, never the market. Where nothing on
              that contract was still awaiting settlement, the refusal was a re-delivery of
              something already decided — the reconciliation sweeps produce those on purpose and
              the contracts reject them by design. Where two or more were waiting, one of them
              failed and the chain does not say which.
            </div>
            {feed.unattributed.map(({ report: r, reason, openAtBlock }) => (
              <div
                key={`${r.txHash}:${r.logIndex}`}
                className="muted-strong"
                style={{ fontSize: 11 }}
              >
                block{" "}
                <a href={blockUrl(r.blockNumber)} target="_blank" rel="noreferrer">
                  {r.blockNumber.toString()}
                </a>{" "}
                · {r.category ?? shortAddress(r.receiver)} ·{" "}
                <span style={{ color: reason === "ambiguous" ? "var(--color-negative)" : undefined }}>
                  {reason === "duplicate"
                    ? "duplicate, nothing was awaiting settlement"
                    : `unexplained — ${openAtBlock} markets were awaiting settlement`}
                </span>{" "}
                ·{" "}
                <a href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                  transaction ↗
                </a>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const POLL_LABEL = "few seconds";


const STATE_COPY: Record<PipelineState, string> = {
  "in-flight": "Waiting for a report",
  rejected: "Report refused",
  settled: "Settled",
  "settled-unattested": "Settled",
  abandoned: "Voided without a settlement",
  paid: "Settled and paid",
};

function AttemptCard({ attempt }: { attempt: Attempt }) {
  const cat = attempt.market ? category(attempt.market.categoryId) : null;
  const refused = attempt.state === "rejected";

  return (
    <div
      className="card"
      style={{ maxWidth: 820, marginBottom: "var(--space-4)", boxShadow: "var(--shadow-md)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {cat && (
          <span className="tag" style={cat.tagStyle}>
            {cat.name}
          </span>
        )}
        <span className="heading" style={{ fontSize: 17 }}>
          {attempt.market?.question ?? attempt.marketKey}
        </span>
        <span
          className="tag"
          style={{
            marginLeft: "auto",
            border: `1px solid ${refused ? "var(--color-negative)" : "var(--color-accent)"}`,
            color: refused ? "var(--color-negative)" : "var(--color-accent)",
            background: "transparent",
          }}
        >
          {STATE_COPY[attempt.state]}
        </span>
      </div>

      <div className="divider" style={{ margin: "var(--space-3) 0" }} />

      <Stage
        n={1}
        title="Requested"
        done={attempt.requested !== null}
        detail={
          attempt.requested && (
            <>
              <BlockLine block={attempt.requested.blockNumber} tx={attempt.requested.txHash} />
              {attempt.requested.terms.length > 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {attempt.requested.terms.map((t) => `${t.label} ${t.value}`).join(" · ")}
                </div>
              )}
            </>
          )
        }
      />

      {/*
        * Deliberately not a progress bar. There is nothing observable between
        * the request and the report — the venue prices are reconciled and
        * discarded, and the evidence document is hashed and never published —
        * so anything that appeared to advance here would be invented.
        */}
      <Stage
        n={2}
        title="Workflow — off chain"
        done={false}
        muted
        detail={
          <div className="muted" style={{ fontSize: 11 }}>
            Not observable. Venue prices are reconciled to a median and discarded; the evidence
            document is hashed, never published.
          </div>
        }
      />

      <Stage
        n={3}
        title="Report delivered"
        done={attempt.report !== null}
        negative={attempt.report !== null && !attempt.report.accepted}
        detail={
          attempt.report && (
            <>
              <div style={{ fontSize: 12 }}>
                <span
                  style={{
                    color: attempt.report.accepted ? "var(--color-accent-300)" : "var(--color-negative)",
                  }}
                >
                  {attempt.report.accepted ? "Accepted by the receiver" : "Refused by the receiver"}
                </span>
              </div>
              <BlockLine block={attempt.report.blockNumber} tx={attempt.report.txHash} />
              {/*
                * Both read off the report itself, not off config. The page can
                * show reports from more than one forwarder at once — during a
                * migration it will — and each must be described by the one that
                * actually delivered it.
                */}
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                forwarder{" "}
                <a href={addressUrl(attempt.report.forwarder)} target="_blank" rel="noreferrer">
                  {shortAddress(attempt.report.forwarder)}
                </a>{" "}
                · execution <span title={attempt.report.workflowExecutionId}>
                  {attempt.report.workflowExecutionId.slice(0, 10)}…
                </span>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {attestationFor(attempt.report.forwarder)}
              </div>
            </>
          )
        }
      />

      <Stage
        n={4}
        title="Written to the market"
        done={attempt.settled !== null}
        negative={refused}
        detail={
          attempt.settled ? (
            <>
              <div style={{ fontSize: 12 }}>
                {outcomeLabel(attempt.settled.outcome as Outcome)}
                {attempt.market && attempt.settled.outcome !== Outcome.Void && (
                  <span className="muted">
                    {" "}
                    · observed{" "}
                    {formatMarketValue(attempt.market.categoryId, attempt.settled.observedValue)}
                  </span>
                )}
              </div>
              <BlockLine block={attempt.settled.blockNumber} tx={attempt.settled.txHash} />
              <div
                className="muted-strong"
                style={{ fontSize: 11, wordBreak: "break-all", marginTop: 2 }}
              >
                evidence hash published by the workflow: {attempt.settled.evidenceHash}
              </div>
            </>
          ) : refused ? (
            <div style={{ fontSize: 12, color: "var(--color-negative)" }}>
              Nothing written — the market is still awaiting settlement. The receiver rejected the
              call and reverted, which leaves no log of its own; the forwarder's verdict above is
              the only record that a delivery happened at all.
            </div>
          ) : null
        }
      />

      {attempt.payouts.length > 0 && (
        <Stage
          n={5}
          title="Paid out"
          done
          detail={
            <div style={{ fontSize: 12 }}>
              {attempt.payouts.length} payment{attempt.payouts.length === 1 ? "" : "s"} ·{" "}
              {formatToken(attempt.payouts.reduce((s, p) => s + p.amount, 0n))}
            </div>
          }
        />
      )}
    </div>
  );
}

function Stage({
  n,
  title,
  done,
  muted,
  negative,
  detail,
}: {
  n: number;
  title: string;
  done: boolean;
  muted?: boolean;
  negative?: boolean;
  detail?: React.ReactNode;
}) {
  const colour = negative
    ? "var(--color-negative)"
    : done
      ? "var(--color-accent)"
      : "var(--color-neutral-600)";
  return (
    <div style={{ display: "flex", gap: "var(--space-3)", padding: "var(--space-2) 0" }}>
      <div
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          borderRadius: "50%",
          border: `1px solid ${colour}`,
          color: colour,
          fontSize: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {n}
      </div>
      <div style={{ minWidth: 0, flex: 1, opacity: muted ? 0.6 : 1 }}>
        <div
          className="muted"
          style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}
        >
          {title}
        </div>
        {detail ?? <div className="muted-strong" style={{ fontSize: 12 }}>—</div>}
      </div>
    </div>
  );
}

function BlockLine({ block, tx }: { block: bigint; tx: string }) {
  return (
    <div className="muted" style={{ fontSize: 11 }}>
      block{" "}
      <a href={blockUrl(block)} target="_blank" rel="noreferrer">
        {block.toString()}
      </a>{" "}
      ·{" "}
      <a href={txUrl(tx)} target="_blank" rel="noreferrer">
        transaction ↗
      </a>
    </div>
  );
}

function HistoryRow({ attempt }: { attempt: Attempt }) {
  const cat = attempt.market ? category(attempt.market.categoryId) : null;
  const refused = attempt.state === "rejected";

  return (
    <tr style={refused ? { boxShadow: "inset 2px 0 0 var(--color-negative)" } : undefined}>
      <td>
        {cat && (
          <span className="tag" style={{ ...cat.tagStyle, marginRight: 8 }}>
            {cat.name}
          </span>
        )}
        {attempt.market?.question ?? attempt.marketKey}
      </td>
      <td>
        {attempt.requested ? (
          <a href={blockUrl(attempt.requested.blockNumber)} target="_blank" rel="noreferrer">
            {attempt.requested.blockNumber.toString()}
          </a>
        ) : (
          <span className="muted">before this scan</span>
        )}
      </td>
      <td>
        {attempt.report ? (
          <span style={{ color: attempt.report.accepted ? undefined : "var(--color-negative)" }}>
            {attempt.report.accepted ? "accepted" : "refused"}
          </span>
        ) : attempt.state === "abandoned" ? (
          /*
           * Not "not in range". That phrase means a forwarder log probably
           * exists and this scan did not reach it — a shrug. Here the market
           * was voided on chain by a call that emits nothing, so no report was
           * ever accepted and none is coming. Saying the two the same way
           * would let a real gap in the scan hide behind a resolved market.
           */
          <span className="muted" title="Status is Void on chain with no settlement log behind it — `ownerVoid` emits nothing.">
            none — voided
          </span>
        ) : (
          <span className="muted" title="No forwarder log in the scanned range — not a failure.">
            not in range
          </span>
        )}
      </td>
      <td>{attempt.settled ? outcomeLabel(attempt.settled.outcome as Outcome) : "—"}</td>
      <td>
        {attempt.settled && attempt.market && attempt.settled.outcome !== Outcome.Void
          ? formatMarketValue(attempt.market.categoryId, attempt.settled.observedValue)
          : "—"}
      </td>
      <td>{gapLabel(attempt)}</td>
      <td>{attempt.payouts.length > 0 ? String(attempt.payouts.length) : "—"}</td>
    </tr>
  );
}

/**
 * Blocks are always knowable; seconds only when both timestamps have loaded.
 * A block count is never multiplied out into a duration — that would be a made
 * up number wearing the clothes of a measured one.
 */
function gapLabel(a: Attempt): string {
  if (a.blocksToReport === null) return "—";
  const blocks = `${a.blocksToReport} block${a.blocksToReport === 1 ? "" : "s"}`;
  if (a.secondsToReport === null) return blocks;
  const s = a.secondsToReport;
  const pretty = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return `${pretty} (${blocks})`;
}
