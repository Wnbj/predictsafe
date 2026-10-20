/**
 * A stand-in for a custodian's account API — the private data source behind
 * the confidential reserve attestation (cre/reserve-attestation).
 *
 * A tokenized fund that is honestly backed holds real assets with a custodian,
 * and the custodian answers "what is in the account" only to someone holding
 * credentials. That is the shape reproduced here: a bearer key, kept in the
 * server-side environment variable CUSTODIAN_API_KEY and, on the workflow
 * side, in the CRE Vault DON — so it is only ever unsealed inside the enclave.
 *
 * What it guards is the balance, CUSTODIAN_BALANCE (a decimal in USD). The
 * workflow compares it with what the exchange's tokens are worth inside the
 * enclave and publishes only a coverage BAND; the balance itself never reaches
 * a node operator, a log, or the chain.
 *
 * `asOf` is the start of the current hour, not "now": every enclave and every
 * retry within the hour must see the same bytes, or the attested results
 * would differ for no reason.
 *
 * Demo data. Not a real account.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Whether the presented header carries the key, compared in constant time.
 * Both sides are hashed first so the comparison never depends on, or reveals,
 * the key's length.
 */
const holdsKey = (header: string, key: string): boolean => {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${key}`));
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function GET(request: Request): Promise<Response> {
  const key = process.env.CUSTODIAN_API_KEY;
  if (!key) return reply(503, { error: "custodian not configured" });

  const auth = request.headers.get("authorization") ?? "";
  if (!holdsKey(auth, key)) return reply(401, { error: "unauthorized" });

  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  return reply(200, {
    custodian: "Demo Custody Bank",
    account: "PS-RESERVE-001",
    currency: "USD",
    balance: process.env.CUSTODIAN_BALANCE ?? "500.00",
    asOf: hour.toISOString(),
  });
}
