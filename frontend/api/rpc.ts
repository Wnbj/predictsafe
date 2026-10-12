/**
 * The site's RPC, as a Vercel Function: the browser posts JSON-RPC here, and
 * this forwards it to the upstream node named by `RPC_UPSTREAM_URL`.
 *
 * Why not just ship the Infura URL as VITE_RPC_URL: every VITE_ variable is
 * compiled into the JavaScript every visitor downloads, and an Infura URL
 * carries its key in the path. Infura's answer is a second, origin-restricted
 * key — which its free plan does not allow. Here the key lives in a server-side
 * environment variable and never reaches a browser.
 *
 * Read methods only. Signing goes through the visitor's own wallet and never
 * touches this endpoint, so nothing that writes, signs or touches accounts has
 * a reason to pass. The worst anyone can do with it is spend the free quota,
 * which is also all they could do with the key.
 */

const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getCode",
  "eth_getBalance",
]);

/** The app sends one request per call (batching is off); this is headroom. */
const MAX_BATCH = 20;

type RpcCall = { method?: unknown; id?: unknown };

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function POST(request: Request): Promise<Response> {
  const upstream = process.env.RPC_UPSTREAM_URL;
  if (!upstream) return reply(500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "RPC proxy not configured" } });

  let body: RpcCall | RpcCall[];
  try {
    body = (await request.json()) as RpcCall | RpcCall[];
  } catch {
    return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  const calls = Array.isArray(body) ? body : [body];
  const refused = calls.find((c) => typeof c?.method !== "string" || !ALLOWED_METHODS.has(c.method));
  if (calls.length === 0 || calls.length > MAX_BATCH || refused) {
    const id = Array.isArray(body) ? null : (body?.id ?? null);
    return reply(403, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not allowed: ${String(refused?.method ?? "batch size")}` },
    });
  }

  let res: Response;
  try {
    res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // A generic message on purpose: a fetch error can quote the URL, and the
    // URL is the key.
    return reply(502, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Upstream RPC unreachable" } });
  }
  // Status passes through on purpose: the app retries an HTTP 429 from the
  // node, and would not retry the same refusal wrapped in a 200.
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
