# PredictSafe

On-chain prediction markets on Ethereum Sepolia, settled by a **Chainlink CRE**
workflow that fetches real-world data, reaches consensus across nodes and writes
a signed report back to the contract.

**Live:** [predictsafe-psi.vercel.app](https://predictsafe-psi.vercel.app/) —
reads Sepolia directly; connect MetaMask on Sepolia to trade.

Five live market categories, two different pricing models, one settlement
mechanism. Everything on screen is read from chain — there is no seeded or
placeholder data anywhere in the app.

> **Proof of concept. Not audited.** MockUSDC is freely mintable and nothing
> here holds real value. See [Limitations](#limitations) for what is genuinely
> unfinished.

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
| **Stocks** | S&P 500 ETF (CSPX), gold, treasury ETFs | Chainlink Data Feeds |
| **Reserves** | Proof-of-Reserve and fund NAV levels | Chainlink PoR feeds |
| **AMM** | same crypto questions, priced by a constant-product pool | same as Crypto |

Alongside the markets, an **exchange** sells synthetic gold and S&P 500 ETF (CSPX) tokens
priced by Chainlink Data Feeds. It is a different product with the same
discipline: every order fills at the next *new* price the feed publishes, and a
Chainlink DON fills orders on a schedule — see
[An exchange must never trade at a known price](#an-exchange-must-never-trade-at-a-known-price).
Its tokens are CCIP cross-chain tokens and move to **Base Sepolia** and back
through **Chainlink CCIP** — see
[The tokens cross chains, the reserve does not](#the-tokens-cross-chains-the-reserve-does-not).

---

## Architecture

```
                    ┌──────────────────────────────────────┐
   real world ──▶   │  CRE workflow  (TypeScript → WASM)   │
   APIs, feeds      │                                      │
                    │  4 log triggers + 5 crons            │
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
   ┌───────────────────────────────┬─────────────────────────────────┐
   │ AssetExchange                 │ Keeper + MarketScheduler        │
   │ (synthetic gold, S&P 500 ETF) │ (settle when due, open markets) │
   └───────────────────────────────┴─────────────────────────────────┘
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
| AssetExchange | `0x46C415C1Ff9A45C291F78cFEe555e6752ddDcf36` |
| sXAU / sCSPX (CCIP tokens) | `0x502640827C31ce347FBe42a5bD6e08Dc98C4a9E0` / `0x2f42A5233311B1Ee291Bfd958039A0449E1F03CD` |
| sXAU / sCSPX on **Base Sepolia** | `0xc20BFD974F374669cAC5994D1E712F03BC102242` / `0x95f4f643654cf63171eD5a8d6751752Ba43793CA` |
| SettlementKeeper | `0xd3b59FA7DfdDdcacf4F251a70F728C7AC0891C43` |
| MarketScheduler | `0x5A3da37c424b7957F6DE67937Bc447a7Fa104B6B` |
| SportsMarket | `0xF30D56E3586091dFe63B74338a194d37Cef80906` |
| ReserveAttestation (confidential workflow) | `0x9e7F6886B01eA9b0E5E9AF8CFF3fc25596718ED0` |

**All five settle through a real DON** — ten nodes, the production
KeystoneForwarder `0xF8344CFd…4482`, workflow `predictsafe-settlement`. Every
family has been proven by reading `ReportProcessed(result = true)` off a
settlement receipt rather than trusting the CLI. A cron sweep runs every thirty
minutes and has done so unattended since 2026-09-20; its only failed executions
were three in one second on 2026-10-05, when every node lost its Sepolia RPC at
once. Since 2026-10-08 settlement is also *requested* without anyone — see
[the keeper](#nobody-presses-the-button-and-the-don-still-cannot-call-it).

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

### An exchange must never trade at a known price

Selling a gold token at the latest feed price is the obvious design, and it
gives money away. Measured on Sepolia: CSPX/USD publishes about once a day and
republishes the same price every Sunday; XAU/USD publishes hourly but put out
24 rounds one Saturday without a single new price. Anyone watching the real
market knows where the next update will land — they buy before it and sell
after it, and the reserve pays for both. Mutual funds solved this long ago the
same way: an order fills at the *next* computed price, never the last one.

"New" turned out to mean two things. A round that repeats the previous price is
a heartbeat — its timestamp is fresh, so a staleness check on time would accept
it; the *price* has to have changed. And a round published in the same block as
the order does not count, or someone who saw the update pending could order in
front of it.

The contract finds the fill price itself. A DON's report carries order ids and
nothing else, and for each one the contract walks the feed from the order's own
round to the first genuine change. Since that round is fixed by the order,
*when* a fill happens cannot change *what* it pays — so filling is open to
anyone, and the DON is a keeper rather than a party that could steer a price.

### The tokens cross chains, the reserve does not

The exchange's gold and S&P 500 ETF tokens are registered **CCIP cross-chain
tokens** with a burn & mint pool on Ethereum Sepolia and on Base Sepolia.
Sending one burns it on the source chain; the CCIP network attests the message
and the destination pool mints the same amount. Supply across the two chains is
constant, so nothing is ever claimed twice.

What does not move is the reserve. A token on Base is a claim on the same
exchange on Sepolia, priced by the same Data Feeds there, so selling means
bringing it back first. That was a deliberate choice over a second exchange on
Base: two reserves would each have to be solvent on their own, and a token
would be worth a different thing depending on where it stood.

It took a second exchange to get here. The first created its own tokens, with
the exchange as their only authority — and CCIP registration needs an admin the
token itself names, so they could never be registered. The tokens are now
Chainlink's `CrossChainToken`, deployed on their own, with the exchange as one
minter and burner and the CCIP pool as the other. The lane runs CCIP 2.0; the
pools are the matching 2.0 `BurnMintTokenPool`. RUNBOOK has the addresses and
the deploy sequence.

**Selling from Base takes one signature.** A token on Base is a claim on the
reserve on Sepolia, so selling it used to mean bringing it back, waiting, then
selling. Now the tokens can travel straight to the exchange with the sale
attached — a CCIP *programmable token transfer*: the message carries the
tokens and the seller's address, and the exchange's `ccipReceive` burns them
and places the sell order the moment they land. It fills at the next new
price like any other order and pays mUSDC on Sepolia. Anything that cannot
become a sale — an unknown token, an asset no longer listed — is handed to the
sender rather than reverted, because a reverted message leaves its tokens
waiting for someone to execute it by hand. Proven 2026-10-19 21:35 UTC: a
sale of 0.004936 sXAU sent from Base Sepolia arrived as order #0
(`CcipSellPlaced`), filled at the next gold price and paid 20.38 mUSDC.

### Proof of backing without the balance: a confidential workflow

The exchange's tokens are claims on a reserve. On chain the reserve is public;
a real tokenized fund, though, holds its backing with a custodian, and the
custodian's account is exactly what must NOT be published — balance, account,
credentials. `cre/reserve-attestation` is a **Chainlink Confidential
Workflow**: its handler runs inside a TEE. It reads what the tokens are worth
from both chains on the DON (public anyway), then — inside the enclave —
unseals the custodian's API key from the Vault DON, fetches the account, and
compares. Only a coverage band crosses back and goes on chain: below 100%,
≥100%, ≥150%, ≥200%, ≥300%, ≥400%, ≥500%. An exact ratio would leak the balance, because the
obligations it is divided by are public. The Trade page shows the band under
the reserve.

What is not confidential, said plainly: the workflow's code (the DON hands the
binary to the enclave) and anything it logs. The custodian here is a demo API
on the same Vercel deployment.

### Football: three AMM markets per match

`SportsMarket` is an `AmmMarket` — the pool maths, buying, selling, redeeming
and liquidity are inherited, not copied — that only the DON can open and
settle. A match is three markets: the home side wins, a draw, the away side
wins, each priced by its own pool and seeded with 10 mUSDC the contract mints
for itself, opening at 45% / 27% / 28%.

Every half hour the workflow reads which matches the contract is waiting on,
asks football-data.org for the Premier League and Champions League fixtures
around today in ONE request per node, and reports either the results of
matches that have finished or the next match to open — never more than three
open at once. The free plan allows ten requests a minute, and every request is
made by all ten nodes, which is why it is one request per run and not one per
match.

**The answer is the score after ninety minutes.** A cup tie level at ninety is
a draw here whoever goes through on extra time or penalties — only then do the
three questions cover every outcome exactly once. A postponed or cancelled
match voids all three markets, and a void pays half a unit per share, as every
AMM market does. A suspended one waits — they are often resumed the same day
— and voids only if it still has no result three days after kickoff.

Consensus is on a digest of the response — each match reduced to its id,
kickoff, status, teams and ninety-minute score, sorted — because the raw body
carries `lastUpdated` stamps that differ between nodes asking a second apart.

### The board opens itself

Every market used to be opened by a person, so most of the time the board
showed only resolved ones. `MarketScheduler` lets the DON open them on a
schedule, in every category:

| category | what opens |
|---|---|
| Crypto | BTC every hour, ETH every four hours, a daily one for each |
| Stocks | gold (XAU) every four hours and the S&P 500 ETF (CSPX) daily at 20:00 UTC — weekdays only, because an exchange-hours feed that does not move voids the market |
| Reserves | USTB NAV and USDW reserves, daily |
| Flights | tomorrow's BA286 (45 min late?) and AA100 (30 min) |
| AMM | a daily BTC market, seeded with 20 mUSDC of liquidity the scheduler mints |
| Sports | a few Premier League and Champions League matches, three markets each — below |

Twice an hour the workflow works out, for each rule, the slot that ends next;
asks the contract in one read which of those are already open; takes strikes
from the right Chainlink Data Feed, rounded to a number a person would type;
and reports up to two markets' terms. The contract opens each on its own
contract through the same public `newMarket` a person would call. Time comes
from DON time and prices from the finalized block, so all ten nodes name the
same markets. A flight needs no lookup to open — only to settle.

What a report may open is bounded in the contract, not the workflow: each
slot at most once (the workflow reads a finalized block, so it can repeat
itself), at least five minutes left to stake, expiry within four days, AMM
liquidity under 100 mUSDC. The keeper and the log handlers then settle these
markets like any other — they open, close, settle and pay without anyone
touching them.

### Nobody presses the button, and the DON still cannot call it

A market settles from the event `requestSettlement` emits, and the contracts
accept a report only for a market already requested. The function is open to
anyone — but a DON's only on-chain write is a signed report delivered to
`onReport`, so the DON cannot be that anyone. For two months every settlement
started with a person clicking.

`SettlementKeeper` closes the gap without touching the five market contracts.
Every ten minutes the workflow asks it which markets are due — one view call
covering all five, against an execution budget of fifteen reads — and reports
the ids back; the keeper makes the public call. The market emits its own
`SettlementRequested` and the DON settles it exactly as after a click. The
first run, on 2026-10-08, did both halves in 26 seconds with no one touching
anything.

The keeper has no more power than any wallet. What it adds is a delay, held in
the contract so a report cannot get around it: **flights wait six hours past
the earliest settlement time**, because a flight still airborne at settlement
voids its market, and a long delay is exactly when Yes should win.

---

## Running it

Nothing is on the default PATH:

```bash
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
```

```bash
cd contracts && forge test                     # 206 tests
cd frontend  && bun install && bun run test    # 181 tests
cd frontend  && bun run dev                    # the app, against live Sepolia
cd frontend  && bun run snapshot               # refresh shipped chain history
cd cre/settlement && bun test                  # 62 tests
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

- **Settlement is automatic, not instant.** A CRE workflow's only on-chain
  write is a signed report, so it cannot call `requestSettlement()` itself.
  `SettlementKeeper` bridges that: every ten minutes the workflow asks it which
  markets are due and reports their ids back, and the keeper makes the public
  call anyone could make. The market then settles through the DON as if the
  button had been pressed. Reads are pinned to the finalized block, which
  trails Sepolia's head by about seventeen minutes, so a market settles some
  twenty to forty minutes after it could have — and a flight six hours after,
  deliberately, because a flight still in the air at settlement voids its
  market. The button still works for anyone in a hurry.
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
- **The exchange's reserve is the counterparty.** When an asset rises, sellers
  are paid from a seeded reserve; a sale it cannot cover is refunded rather than
  paid in part. Real tokenized assets are backed by the asset itself — these are
  backed only by the reserve, on a testnet, with mock money.
- **An exchange order can wait a long time.** It fills at the next new price:
  within about an hour for gold on a weekday, about a day for the S&P 500, and
  not at all over a weekend. That is the price of never trading at a known one.
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
