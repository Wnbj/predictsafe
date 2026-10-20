# PredictSafe frontend

React + Vite + viem. Everything on screen is read from Sepolia — there is no
seeded or placeholder data. The project overview is in the
[root README](../README.md); operating it is in [RUNBOOK](../RUNBOOK.md).

```bash
bun install
bun run dev        # http://localhost:5173
bun run test       # vitest
bun run build      # typecheck + production build
bun run snapshot   # refresh public/logs-snapshot.json before a demo
```

Wallet actions need an injected wallet (EIP-6963, MetaMask or any other) on
Sepolia. Reads work without one.

## Pages

| route | view | what it shows |
|---|---|---|
| `/` | Landing | stats, categories, most-backed markets |
| `/markets` | Markets | every market, filterable by category; untouched test markets hidden behind a count |
| `/markets/:category/:id` | Detail | odds, price chart, strike ladder, stake / buy / sell, settlement evidence |
| `/portfolio` | Portfolio | the wallet (mUSDC and tokens on both chains, buy / sell and CCIP transfer dialogs, activity), then market positions with claim / redeem / withdraw |
| `/trade` | Trade | the synthetic gold and S&P 500 ETF exchange: assets, the order form (shared with the wallet's dialog), orders, reserve |
| `/leaderboard` | Leaderboard | wallets scored against resolved outcomes |
| `/live` | Live | settlements arriving from the DON, read from logs every six seconds |

Trade and Portfolio render outside the markets loading gate: neither waits for
every market to load before showing what it can.

## Configuration

Defaults in `src/lib/config.ts` point at the deployed POC. Override in
`.env.local` (gitignored):

| variable | default |
|---|---|
| `VITE_RPC_URL` | `/api/rpc` in a production build, the public Sepolia node in dev — set a keyed endpoint locally |
| `VITE_FLIGHT_MARKET_ADDRESS` | FlightMarket |
| `VITE_CRYPTO_MARKET_ADDRESS` | CryptoMarket |
| `VITE_STOCK_MARKET_ADDRESS` | StockMarket |
| `VITE_RESERVE_MARKET_ADDRESS` | ReserveMarket |
| `VITE_AMM_MARKET_ADDRESS` | AmmMarket |
| `VITE_EXCHANGE_ADDRESS` | AssetExchange |
| `VITE_TOKEN_ADDRESS` | MockUSDC |
| `VITE_FORWARDER_ADDRESS` | production KeystoneForwarder |
| `VITE_DEPLOY_BLOCK` | where log scans start |

`cre/preflight.sh` compares these defaults against the workflow's config, so
a redeploy that updates one side and not the other shows up there.

## Reading the chain on a free RPC

The app is sized to fit a free tier, and most of `src/lib` exists for that:

- **One paced queue** for every request (`chain.ts`), one at a time, with a
  priority lane for the handful of reads a page is visibly waiting on — the
  exchange's. JSON-RPC batching is OFF: Infura answers a throttled batch entry
  with no envelope, and viem returns it as a successful `undefined`.
- **One log walk** (`logScan.ts`) shared by every consumer, querying all
  receivers per chunk, cached in localStorage as raw logs.
- **A shipped snapshot** (`public/logs-snapshot.json`) so a first visit scans
  only the tail. Re-run `bun run snapshot` before a demo.
- **Markets first, history after.** The pages render as soon as the markets
  are read — eight requests, with `aggregate3` batches of up to 256 KB instead
  of viem's 1 KB default — while history and the wallet's positions fill in.
  Portfolio and Leaderboard wait for those, rather than claim "nothing here".
- **Last visit's markets** (`marketCache.ts`) render at once on a return,
  under a one-line "updating" notice, until this visit's read replaces them.
  The key carries the build's chunk URL, so a deploy never feeds old shapes to
  new code. A first visit shows card outlines instead.

## Hosting

Deployed on Vercel from this folder; `vercel.json` holds the build and the
rewrite that keeps deep links working — deliberately narrow, see RUNBOOK for
the blank page a wider one caused. A hosted build reads
the chain through `api/rpc.ts`, a read-only proxy that keeps the provider key
server-side in `RPC_UPSTREAM_URL`; locally, `VITE_RPC_URL` in `.env.local` goes
to the node directly. Setup is in RUNBOOK under "Hosting the frontend".

## Cross-chain tokens (CCIP)

`src/lib/ccip.ts` holds both chains' CCIP routers and selectors and the
exchange tokens' addresses on Base Sepolia, and builds `ccipSend` calls with the
fee in native gas. `components/Wallet.tsx` is the portfolio's wallet card —
balances per chain, total in dollars, Assets and Activity tabs — and
`BridgeDialog.tsx` the send. Selling from Base is a third case, in
`TradeForm.tsx`: one `ccipSend` to the exchange with the seller as data and a
gas limit for `ccipReceive`, so the order is placed on arrival
(`sellOnArrival` in `lib/ccip.ts`). `lib/transfers.ts` keeps sent transfers in
localStorage and marks one arrived when the destination token mints exactly
that amount to the wallet after the send — or, for a sale, when the exchange
holds a sell order for exactly that amount. Base Sepolia is read straight from
its public RPC (`https://sepolia.base.org`, which answers browser origins but
caps `eth_getLogs` at 200 blocks); Sepolia still goes through the paced queue.
`writeWithApproval` and `waitForTx` take a token and a `TxNetwork`, so the same
one-prompt approval works for a bridge from either side.

## Football

`lib/sports.ts` and `readSportsMarkets` in `lib/chain.ts`. A football market is
`SportsMarket` in `lib/types.ts`: an AMM market with a `match` and no asset or
strike. **Anything about money asks `isAmm(m)`, never `categoryId === "amm"`** —
the sports category is an AMM too. A match's three markets group into one
event (`lib/events.ts`), shown like a strike ladder with the teams and "Draw"
as rungs. The contract stores no question; the app writes it from the match.

## Images

Category and asset cover photos are in `public/img/`, from Pexels — credits in
[`public/img/CREDITS.md`](public/img/CREDITS.md). `coverBackground` in
`src/lib/categories.tsx` lays them under a gradient of the page background;
categories without a photo keep the plain gradient.

## Adding a category

`src/lib/categories.tsx` is the extension point. Non-live categories already
render as "coming soon". To light one up: set `live: true` (and an `image`),
then teach `readMarkets` in `src/lib/chain.ts` to load that contract into the
shared `Market` shape. Cards, filters, detail, portfolio and leaderboard all
key off `Market.categoryId`.
