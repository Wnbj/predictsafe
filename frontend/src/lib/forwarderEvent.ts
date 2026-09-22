import { parseAbiItem } from "viem";

/**
 * The forwarder's verdict on a delivered report.
 *
 * In a module of its own, importing nothing from this app, and that is the
 * point. It used to live in `logScan.ts`, and `settlementEvents.ts` read it at
 * module load to build `SETTLEMENT_EVENTS`. The two sit on an import cycle
 * through `chain.ts`, so whether the constant existed yet depended on which
 * file a program happened to import first. The browser's entry order hid it;
 * the snapshot script, entering through `logScan`, got `Cannot access
 * 'REPORT_PROCESSED_EVENT' before initialization`. A leaf has no order to get
 * wrong.
 *
 * Verified by hash against a real receipt rather than taken from documentation:
 * topic0 is 0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5.
 * The hash pins the TYPES only — the RUNBOOK calls the bool both `success` and
 * `result`, and nothing on chain settles which name is right. `result` is what
 * the upstream KeystoneForwarder declares.
 */
export const REPORT_PROCESSED_EVENT = parseAbiItem(
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
);
