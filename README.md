# PredictSafe

On-chain prediction markets on Ethereum Sepolia, settled by a **Chainlink CRE**
workflow that fetches real-world data, reaches consensus across nodes and writes
a signed report back to the contract.

Five live market categories, two different pricing models, one settlement
mechanism. Everything on screen is read from chain — there is no seeded or
placeholder data anywhere in the app.

> **Proof of concept. Not audited.** MockUSDC is freely mintable and nothing
> here holds real value. See [Limitations](#limitations) for what is genuinely
> unfinished, including the one thing that stops it running unattended.

---

## What it does

A market asks a yes/no question about the world — *will this flight arrive 30+
minutes late? will BTC be above $63,000 in an hour? will stETH reserves stay
above 9 million?* — takes money on both sides, and pays out when a Chainlink
DON agrees on the answer.

The interesting part is not the betting. It is that **the resolution rules live
on chain and the oracle has no discretion**: the workflow reports a number, the
contract compares it to a strike, and everything ambiguous refunds rather than
guessing.

| Category | Question | Settled from |
|---|---|---|
| **Flights** | arrival delay vs a threshold | AeroDataBox, via HTTPS |
| **Crypto** | BTC/ETH vs a strike, 5 min to 1 hour | median of Coinbase, Kraken, Bitstamp |
| **Stocks** | S&P 500 (CSPX), gold, treasury ETFs | Chainlink Data Feeds |
| **Reserves** | Proof-of-Reserve and fund NAV levels | Chainlink PoR feeds |
| **AMM** | same crypto questions, priced by a constant-product pool | same as Crypto |

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   real world ──▶   │  CRE workflow  (TypeScript → WASM)   │
   APIs, feeds      │                                      │
                    │  4 log triggers + 3 cron sweeps      │
                    │  DON consensus on every value        │
                    └──────────────┬───────────────────────┘
                                   │ signed report
                                   ▼
                    ┌──────────────────────────────────────┐
   Sepolia          │  KeystoneForwarder → onReport()      │
                    │  forwarder + author + name checks    │
                    └──────────────┬───────────────────────┘
                                   ▼
   ┌──────────────┬────────────────────┬─────────────┬──────────────┐
   │ FlightMarket │ ParimutuelMarket   │ AmmMarket   │  MockUSDC    │
   │ (standalone, │  ├ CryptoMarket    │ (constant   │ (shared      │
   │  predates    │  ├ StockMarket     │  product)   │  stake       │
   │  the base)   │  └ ReserveMarket   │             │  token)      │
   └──────────────┴────────────────────┴─────────────┴──────────────┘
                                   ▲
                                   │ viem, EIP-6963
                    ┌──────────────┴───────────────────────┐
                    │  React + Vite frontend               │
                    └──────────────────────────────────────┘
```

**Deployed on Sepolia:**

| | |
|---|---|
| FlightMarket | `0x09068efb21fabeac59694e01428cf438cf38e2b3` |
| CryptoMarket | `0x8DA11eb17D5F3f4427aA3017E95e50b132A210be` |
| StockMarket | `0x451bcdB90EC6f6F5f40B5B2578aef641e36b71ca` |
| ReserveMarket | `0xa768Be2741A0464b81606649eCa45bfF7aD4d939` |
| AmmMarket | `0xc9961096dc98eE17eD28bB417BB726F1b64f84FF` |
| MockUSDC | `0xcd123a8d74ef062dddd2287e87bc88eb3b208b54` |

**All five settle through a real DON** — ten nodes, the production
KeystoneForwarder `0xF8344CFd…4482`, workflow `predictsafe-settlement`. Every
family has been proven by reading `ReportProcessed(result = true)` off a
settlement receipt rather than trusting the CLI. A cron sweep runs every thirty
minutes and has done so unattended since 2026-09-20 without a single failed
execution.

---

## Decisions worth explaining

Most of this repo is ordinary. These are the parts that were not, and each one
came out of something measured rather than assumed.

### Chainlink Data Feeds are right for stocks and wrong for crypto

The obvious way to settle a BTC price market is a Data Feed. Measured directly
on Sepolia, BTC/USD updates on a **flat 60-minute heartbeat with no deviation
trigger** — six consecutive rounds exactly 60 minutes apart. A 5-minute market
read from it compares a price against *itself* about 92% of the time and always
resolves No: rigged by data cadence rather than by anyone's intent.

So crypto settles from exchange candles, and stocks — where the natural horizon
is a session, not five minutes — settle from feeds. Same product, opposite
verdict, because the question is on a different timescale.

### The hard part of an equity market is the calendar, not the price

A feed keeps publishing while the exchange behind it is shut, republishing the
last price with a fresh timestamp. Measured over a week: CSPX/USD changed on
every weekday round and **not once from Friday to Saturday**; XAU/USD sat at
exactly 4,377.25 for twelve consecutive hourly rounds across a Saturday.

A market expiring while the exchange is closed is decided the moment the bell
rings. The chain cannot know an exchange calendar — but it can notice that
nothing happened, so `StockMarket` voids unless the answer actually *changed*
between the book closing and expiry.

`ReserveMarket` is a separate contract precisely because that rule is wrong for
reserves, which can legitimately sit still for a day. It does not even emit
`closeTime`, so the workflow cannot apply the check by accident.

### Sources must agree on the outcome, not on the number

Two venues forty cents apart either side of a strike are numerically
near-identical and disagree completely about who gets paid. Averaging them
invents an answer neither venue gave, so disagreement on the *outcome* voids
the market instead.

### Feeds do not agree on decimals

CSPX publishes 8, USTB NAV publishes 6, stETH Proof of Reserves publishes 18.
Read as 8, USTB's $11.177748 becomes $0.11 — and stETH's raw answer,
`9505650857465828722927470`, does not fit in a `uint64` strike at all. The
workflow reads `decimals()` and normalises, but checks *movement* on the raw
answers, because rescaling can truncate a real move into "nothing happened".

### Reads are pinned to a block

Every DON node runs the workflow independently. Reading a feed at `latest`
gives each node whichever chain head it happened to see, so the report bytes
differ and consensus fails. Log-triggered settlements pin to the block their
own trigger event was mined in; the cron sweeps pin to the last finalized
block. Same reason the crypto path uses closed one-minute candles rather than
spot quotes.

### The AMM is a different product, not a tuning

In a parimutuel market you do not buy at a price, you join a pool — every later
stake on your own side dilutes you through nothing you did. `AmmMarket` gives
you a fixed number of shares at a price that later trades cannot touch, and
lets you sell out before expiry.

Solvency is structural rather than tested-for: collateral only enters by
minting **complete sets**, one unit in minting one YES and one NO, so
`totalYes == totalNo == collateral` always holds and every share is backed by
its own unit. Rounding always favours the pool — and the sell path asserts the
constant product outright, because getting that rounding backwards drained the
pool a little on every single trade.

Anyone can provide the liquidity. A deposit scales both reserves by a common
factor, which is the only way to add depth without moving the price, and hands
back whatever the pool could not absorb as a real directional position — the
same thing that happens to whoever opens a market away from even money.
Providers are paid by a fee that is **kept in the reserves** rather than
collected anywhere: that single choice makes fee income independent of which
side wins, and means a late provider mints proportionally fewer shares and so
cannot claim fees earned before they arrived. Neither property needs any
bookkeeping to enforce.

### Strike ladders are derived, not stored

A ladder is N markets sharing an asset and an expiry and differing only in
strike, so the UI groups them from exactly that. No contract change was needed,
and it works retroactively on ladders created before the code existed.

### Ten nodes against a rate limit that tolerates one

A DON reaches consensus over an HTTP read by having **every node make the
call**. The flight provider is a free RapidAPI tier, and the first settlement
on the real DON got one answer and nine HTTP 429s in the same second — nine
errors is more than the network tolerates, so the market voided.

The shape of that failure was the clue. An exhausted quota would have failed
all ten; one success meant the key was fine and the limit was about
*simultaneity*. So each node now waits a random time before every attempt —
full jitter over a doubling window, including the first attempt, because t=0
is the one moment all ten are guaranteed to arrive together. A fixed backoff
would only move the collision. Four consecutive runs afterwards: ten of ten
nodes every time, forty calls in ten minutes, zero refusals.

This varies *when* a node calls, never what it answers, so it does not touch
consensus.

### Read the chain once, not twenty times

The live view is built from logs, and every decoder used to fetch its own:
fourteen separate walks of a quarter of a million blocks, about 520 requests
for one page load, which no free RPC would serve. `eth_getLogs` takes an array
of addresses, and these contracts emit nothing the app does not want — so one
query per chunk returns everything and the decoders sort it by topic0
afterwards. Two queries, in fact: forwarder logs keep an indexed filter,
because other people's workflows share that forwarder.

The trap in sorting by topic0 rather than by event name: `FlightMarket` and the
other four both emit an event called `Settled`, one with an `int32` and one
with an `int256`. Same name, same indexed argument. Matching on the name would
decode a flight's delay through the wrong ABI and produce a plausible number.

### The SDK's types promise more than its runtime has

`@chainlink/cre-sdk` declares a `randomSeed()` global with a docstring. It
typechecks. It does not exist at runtime — a host binding for the SDK itself,
not part of the workflow sandbox. `setTimeout` at least announces that it is
unavailable; this does not. A `typeof` sweep from inside a running handler
found `sleep`, `Math.random` and `Date.now`, which is what the jittered retry
uses instead. A typecheck proves someone wrote a declaration, not that the host
implements it.

---

## Running it

Nothing is on the default PATH:

```bash
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
```

```bash
cd contracts && forge test                     # 170 tests
cd frontend  && bun install && bun run test    # 164 tests
cd frontend  && bun run dev                    # the app, against live Sepolia
cd frontend  && bun run snapshot               # refresh shipped chain history
cd cre/settlement && bun test                  # 55 tests
```

The app needs an RPC that serves `eth_getLogs` over a 10,000-block range. The
public node's default works but is unreliable for log scans; a free Infura key
in `frontend/.env.local` as `VITE_RPC_URL` is what the app is sized for. See
RUNBOOK for why Alchemy's and QuickNode's free tiers do not work at all.

Settling a market end to end, deploying the contracts, and every operational
detail lives in **[RUNBOOK.md](RUNBOOK.md)** — including the two settings
(`FORWARDER`, `WORKFLOW_AUTHOR`) that are not what the CLI's own output
suggests, and which cost an afternoon to find.

---

## Limitations

Stated plainly, because a POC that hides these is worse than one that does not
have them.

- **A market still has to be asked to settle.** A CRE workflow's only on-chain
  write is a signed report, so it cannot call `requestSettlement()` itself —
  someone presses the button, or calls it. Everything AFTER that is unattended:
  the DON settles within seconds, and a cron sweep every thirty minutes
  re-settles anything the log trigger missed. Full autonomy needs
  `_processReport` to accept any market past its settle-after time, dropping
  the request step.
- **One flight data provider.** The two-source disagreement logic is built and
  tested, but the second slot was only ever exercised with a mock. The
  provider is a free RapidAPI tier, which works on a ten-node DON only because
  of the jittered retry described above — a stricter limit could break it.
- **The RPC is a free tier.** The app is sized to fit it, not to have headroom.
- **AMM liquidity can only be withdrawn after settlement.** Providers may
  deposit while a market is open, but there is no remove-while-open: taking
  liquidity out of a live book is where the silent mistakes are, and the
  deposit-only direction covers what these markets actually need.
- **`FlightMarket` predates `ParimutuelMarket`** and does not inherit it. It is
  deployed with live positions, so the parimutuel logic exists in two places
  until it is next redeployed.
- **`ownerVoid` exists on every market.** An escape hatch for a POC, and it
  emits no event, which the live view has to account for separately. It should
  not survive into anything real.
- Not audited. Not for real money.

---

## A note on names

`cre/settlement/` used to be `flight-market/flight-settlement/`, from when
flights were the only category. The workflow was deployed to the DON as
`predictsafe-settlement`, and every contract was switched to expect that name
at the same time as its forwarder.

The name is not a label. A fingerprint of it — `sha256(name)`, hex-encoded,
first ten characters, those characters stored as `bytes10` — sits in every
contract and is checked on every report. A contract expecting the wrong name
rejects every settlement **silently**, because the forwarder swallows a failed
receiver call into an event rather than reverting. `cre/preflight.sh
production` checks it, with the author and forwarder, on all five contracts.
