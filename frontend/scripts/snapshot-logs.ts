/**
 * Write `public/logs-snapshot.json`: every log the app needs, up to a recent
 * block, so a first visit scans only the tail. See `SNAPSHOT_URL` in
 * `src/lib/logScan.ts` for why.
 *
 *   cd frontend && bun run snapshot
 *
 * Reads the RPC from `.env.local` exactly as the app does — bun loads it — and
 * scans with the app's own `syncLogs`, so the file cannot drift from what the
 * page would have read itself.
 *
 * Re-run before a demo. A stale snapshot is never wrong, only slower: every
 * 10,000 blocks it falls behind costs a first visit two more requests.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONTRACTS_FINGERPRINT, bigintReplacer } from "../src/lib/logCache";
import { syncLogs, type RawLog } from "../src/lib/logScan";
import { readSettlementLogs } from "../src/lib/settlementEvents";
import { fetchBlockTimes } from "../src/lib/blockTime";

/**
 * How far behind the head the snapshot stops.
 *
 * A shipped file is not re-read, so it must not contain anything a reorg could
 * still remove. Sepolia reorgs are rare and shallow; 64 blocks is ample, and
 * the app re-reads everything after the snapshot's head on every visit anyway.
 */
const FINALITY = 64n;

/** Only what `parseEventLogs` and the decoders read. Decoded `args` are not kept. */
const canonical = (l: RawLog): RawLog =>
  ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    transactionIndex: l.transactionIndex,
    logIndex: l.logIndex,
    removed: false,
  }) as RawLog;

/**
 * viem puts the full request URL in its errors, and an Infura URL carries the
 * API key in its path. Print the host and nothing after it.
 */
const redact = (message: string) =>
  message.replace(/https?:\/\/([^/\s]+)\S*/g, "https://$1/…");

/**
 * Patient, because this runs once before a demo rather than on every visit.
 *
 * A failed range fails its whole source, and the cursor does not move, so the
 * next attempt re-reads everything — which is what makes retrying the entire
 * scan correct rather than wasteful. The free tier's rate limit recovers in
 * about two minutes (measured 2026-09-22); the pause is sized to that.
 */
const ATTEMPTS = 3;
const COOL_OFF_MS = 90_000;

let scan = await syncLogs();
for (let attempt = 2; scan.failures.length > 0 && attempt <= ATTEMPTS; attempt++) {
  for (const f of scan.failures) console.error(`${f.source}: ${redact(f.message).split("\n")[0]}`);
  console.error(`attempt ${attempt - 1} incomplete — waiting ${COOL_OFF_MS / 1000}s for the RPC`);
  await new Promise((r) => setTimeout(r, COOL_OFF_MS));
  scan = await syncLogs();
}
if (scan.failures.length > 0) {
  // A partial snapshot would hide those logs from every first visit, for as
  // long as the file ships. Refusing is the only safe answer.
  for (const f of scan.failures) console.error(`${f.source}: ${redact(f.message).split("\n")[0]}`);
  console.error("Scan incomplete — snapshot NOT written.");
  process.exit(1);
}

const head = scan.head - FINALITY;
const within = (l: RawLog) => l.blockNumber <= head;
const receiver = scan.receiver.filter(within).map(canonical);
const forwarder = scan.forwarder.filter(within).map(canonical);

// The blocks the pipeline actually renders a time for — the same filter as
// `useSettlementFeed`. `readSettlementLogs` decodes from the store just filled,
// so this costs no further log requests.
const { logs } = await readSettlementLogs();
const rendered = logs
  .filter((l) => l.blockNumber <= head)
  .flatMap((l) =>
    l.kind === "requested" || l.kind === "report" || l.kind === "settled" ? [l.blockNumber] : [],
  );
const times = await fetchBlockTimes(rendered, Number.POSITIVE_INFINITY);
const blockTimes = [...new Set(rendered)]
  .filter((b) => times.has(b))
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  .map((b) => [b, times.get(b)!] as const);

const out = resolve(import.meta.dir, "../public/logs-snapshot.json");
// Vite serves `public/` at the site root; the project had no such folder before this.
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    { version: 1, contracts: CONTRACTS_FINGERPRINT, head, receiver, forwarder, blockTimes },
    bigintReplacer,
  ),
);

console.log(
  `wrote ${out}\n  head ${head}  receiver ${receiver.length}  forwarder ${forwarder.length}  ` +
    `block times ${blockTimes.length}/${new Set(rendered).size}`,
);
