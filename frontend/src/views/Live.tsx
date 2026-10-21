import { category } from "../lib/categories";
import {
  addressUrl,
  attestationFor,
  blockUrl,
  txUrl,
} from "../lib/config";
import {
  formatMarketValue,
  formatRelative,
  formatTimestamp,
  formatToken,
  outcomeLabel,
  shortAddress,
} from "../lib/format";
import { isUnstakedAndResolved } from "../lib/pricing";
import { useNow } from "../hooks/useNow";
import { useState } from "react";
import { history, inFlight, type Attempt, type PipelineState } from "../lib/pipeline";
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
  const now = useNow(30_000);
  // The same rule the Markets board uses: a market nobody staked on is a
  // rehearsal. Its settlement is real, but a table of near-identical test runs
  // buries the ones that paid anyone. Counted, and one click away.
  const [showRehearsals, setShowRehearsals] = useState(false);
  const [shown, setShown] = useState(12);
  const allDone = history(feed);
  const rehearsals = allDone.filter((a) => a.market !== null && isUnstakedAndResolved(a.market)).length;
  const done = showRehearsals
    ? allDone
    : allDone.filter((a) => a.market === null || !isUnstakedAndResolved(a.market));
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
    <div className="page live-page">
      <h2 className="heading" style={{ fontSize: 32, margin: "0 0 var(--space-2)" }}>
        Settlement pipeline
      </h2>
      <p className="muted" style={{ margin: "0 0 var(--space-6)", maxWidth: 760 }}>
        Read straight from Sepolia logs, every {POLL_LABEL}. Nothing on this page is pushed to
        it — when a settlement is requested anywhere, it appears here on its own. It shows that a
        report was delivered and accepted; it does not re-check the price the workflow saw.
      </p>

      <section className="wallet live-head" aria-label="Pipeline status">
        <div className="wallet-head">
          <div>
            <div className="eyebrow live-eyebrow">
              <span className={`live-dot${feed.lastPollAt ? " on" : ""}`} aria-hidden="true" />
              Watching Sepolia
            </div>
            <div className="wallet-total">{feed.head > 0n ? `#${feed.head.toLocaleString()}` : "…"}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {feed.lastPollAt
                ? `latest block · read ${formatTimestamp(Math.floor(feed.lastPollAt / 1000))}`
                : "connecting…"}
            </div>
          </div>
          <div className="positions-stats">
            <div className={waiting.length > 0 ? "accent" : undefined}>
              <span>In flight</span>
              <b>{waiting.length}</b>
            </div>
            <div>
              <span>Settled</span>
              <b>{settledCount}</b>
            </div>
            <div className={rejected > 0 ? "negative" : undefined}>
              <span>Refused</span>
              <b>{rejected}</b>
            </div>
          </div>
        </div>
      </section>

      {feed.failures.length > 0 && (
        <div className="wallet live-failures">
          {feed.failures.map((f) => (
            <div key={f.family}>
              <strong>{f.family}</strong> logs could not be read — that part of every pipeline
              below is missing, not absent. {f.message.split("\n")[0]}
            </div>
          ))}
        </div>
      )}

      <section className="wallet" aria-label="In flight">
        <div className="eyebrow">In flight</div>
        {waiting.length === 0 ? (
          <div className="live-idle">
            <span className="live-idle-ring" aria-hidden="true" />
            <div>
              <div style={{ fontWeight: 500 }}>Nothing being settled right now</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {feed.loading
                  ? "Reading the chain…"
                  : "Request a settlement — or wait for the keeper — and this fills in by itself."}
              </div>
            </div>
          </div>
        ) : (
          waiting.map((a) => <AttemptCard key={a.id} attempt={a} />)
        )}
      </section>

      {done.length > 0 && (
        <section className="wallet" aria-label="Settled to date">
          <div className="live-list-head">
            {/* "Resolved", not "settled": the list also holds markets the owner
                voided, which the Settled count above leaves out on purpose —
                and the count above includes the test runs hidden here. */}
            <div className="eyebrow">Resolved to date · {done.length}</div>
            {rehearsals > 0 && (
              <button type="button" className="linklike muted" style={{ fontSize: 12 }} onClick={() => setShowRehearsals((v) => !v)}>
                {showRehearsals
                  ? `hide ${rehearsals} test run${rehearsals === 1 ? "" : "s"}`
                  : `${rehearsals} test run${rehearsals === 1 ? "" : "s"} hidden`}
              </button>
            )}
          </div>
          <ul className="wallet-list">
            {done.slice(0, shown).map((a) => (
              <HistoryRow key={a.id} attempt={a} times={feed.blockTimes} now={now} />
            ))}
          </ul>
          {done.length > shown && (
            <button className="btn positions-more" onClick={() => setShown(done.length)}>
              Show all {done.length}
            </button>
          )}
        </section>
      )}

      {feed.unattributed.length > 0 && (
        <section className="wallet" aria-label="Refused reports with no market named">
          <div className="eyebrow">Refused reports with no market named</div>
          <div>
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
    <div className={`attempt${refused ? " refused" : ""}`}>
      <div className="attempt-head">
        {cat?.image ? (
          <img className="wallet-icon" src={cat.image} alt="" />
        ) : (
          <span className="wallet-icon wallet-icon-glyph live" aria-hidden="true">⟳</span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wallet-row-name">{attempt.market?.question ?? attempt.marketKey}</div>
          {cat && <div className="muted" style={{ fontSize: 12 }}>{cat.name}</div>}
        </div>
        <span className={`wallet-status ${refused ? "lost" : "pending"}`}>
          {!refused && <span className="spinner" aria-hidden="true" />}
          {STATE_COPY[attempt.state]}
        </span>
      </div>

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
  const state = negative ? "negative" : done ? "done" : "todo";
  return (
    <div className={`stage ${state}${muted ? " muted-stage" : ""}`}>
      <div className="stage-n">{done && !negative ? "✓" : n}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="stage-title">{title}</div>
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

function HistoryRow({
  attempt,
  times,
  now,
}: {
  attempt: Attempt;
  times: ReadonlyMap<bigint, number>;
  now: number;
}) {
  const cat = attempt.market ? category(attempt.market.categoryId) : null;
  const refused = attempt.state === "rejected";

  const requestedAt =
    attempt.requested && times.has(attempt.requested.blockNumber) ? times.get(attempt.requested.blockNumber)! : null;
  const outcome = attempt.settled ? (attempt.settled.outcome as Outcome) : null;

  return (
    <li className={`wallet-row position-row${refused ? " refused" : ""}`}>
      {cat?.image ? (
        <img className="wallet-icon" src={cat.image} alt="" />
      ) : (
        <span className="wallet-icon wallet-icon-glyph" aria-hidden="true">✓</span>
      )}
      <div className="wallet-row-main">
        <div className="wallet-row-name">{attempt.market?.question ?? attempt.marketKey}</div>
        <div className="wallet-row-chains">
          {cat && <span className="muted">{cat.name}</span>}
          {attempt.requested ? (
            // When, in words; the block it happened in is a hover and a click
            // away. A column of eight-digit block numbers told nobody anything.
            <a
              className="muted"
              href={blockUrl(attempt.requested.blockNumber)}
              target="_blank"
              rel="noreferrer"
              title={`block ${attempt.requested.blockNumber}${requestedAt ? ` · ${formatTimestamp(requestedAt)}` : ""}`}
            >
              requested {requestedAt ? formatRelative(requestedAt, now) : `at block ${attempt.requested.blockNumber}`}
            </a>
          ) : attempt.market?.categoryId === "sports" ? (
            // A match has no request step: the DON reads the result and
            // settles all three markets on its own schedule.
            <span className="muted">settled by the DON directly, no request</span>
          ) : (
            <span className="muted">requested before this scan</span>
          )}
          {attempt.report ? (
            <span className={attempt.report.accepted ? "up" : "down"}>
              report {attempt.report.accepted ? "accepted" : "refused"}
              {attempt.report.accepted && attempt.blocksToReport !== null && (
                <span className="muted"> in {gapLabel(attempt)}</span>
              )}
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
              no report — voided
            </span>
          ) : (
            <span className="muted" title="No forwarder log in the scanned range — not a failure.">
              report not in range
            </span>
          )}
        </div>
      </div>
      <div className="wallet-row-value">
        <span className={`wallet-status ${outcome === Outcome.Yes ? "done" : outcome === Outcome.No ? "neutral" : outcome === null ? "lost" : "slow"}`}>
          {outcome !== null ? outcomeLabel(outcome) : refused ? "Refused" : "—"}
        </span>
        <div className="muted" style={{ fontSize: 12 }}>
          {attempt.settled && attempt.market && attempt.settled.outcome !== Outcome.Void
            ? formatMarketValue(attempt.market.categoryId, attempt.settled.observedValue)
            : ""}
        </div>
      </div>
      <div className="wallet-row-action position-actions">
        {attempt.payouts.length > 0 && (
          <span className="muted" style={{ fontSize: 12, textAlign: "right" }}>
            {attempt.payouts.length} paid
          </span>
        )}
        {(attempt.settled ?? attempt.report) && (
          <a
            className="btn position-view"
            href={txUrl((attempt.settled ?? attempt.report)!.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            Tx ↗
          </a>
        )}
      </div>
    </li>
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
