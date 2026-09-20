# PredictSafe — POC runbook

End-to-end settlement (real Sepolia log trigger → CRE workflow → real
`onReport()` write → real `claim()` payout, all verified via on-chain state,
not just CLI output) is **proven**. `FlightMarket.sol` inherits
`ReceiverTemplate` (from smartcontractkit/cre-gcp-prediction-market-demo) for
forwarder/author/name validation instead of hand-rolled checks.

The full money flow was exercised on real Sepolia across three markets (Yes,
No, Void) with two independent stakers, then both claimed:

| staker | market 0 (Yes) | market 1 (No) | market 2 (Void) | total received |
|---|---|---|---|---|
| alice (staked YES: 1e6/1e6/1e6) | wins: 4e6 | loses: reverts `NothingToClaim` | refund: 1e6 | 5e6 |
| bob (staked NO: 3e6/3e6/3e6) | loses: reverts `NothingToClaim` | wins: 4e6 | refund: 3e6 | 7e6 |

Contract's MockUSDC balance after all four claims: **0** — fully drained, no
dust. Numbers match the parimutuel math exactly.

## Toolchain

None of these are on the default PATH:

```bash
export PATH="$HOME/.cre/bin:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"
```

## 1. Contract tests

```bash
cd contracts && forge test
```

24 tests, incl. a 256-run fuzz on payout solvency. `via_ir = true` is required —
the 12-field `Market` struct blows the stack otherwise.

## 2. Deploy to Sepolia

```bash
cd contracts
export DEPLOYER_PK=<funded Sepolia key>
export FORWARDER=0x15fC6ae953E024d975e77382eEeC56A9101f9F88
export WORKFLOW_NAME=flight-settlement-staging
export WORKFLOW_AUTHOR=0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa
forge script script/Deploy.s.sol:Deploy --rpc-url https://ethereum-sepolia-rpc.publicnode.com --broadcast
```

**`FORWARDER` and `WORKFLOW_AUTHOR` are not obvious — both were found by tracing
a failed delivery, not by reading a flag description:**

- `FORWARDER` depends on **who will deliver the report**, and the two are not
  interchangeable. `cre workflow supported-chains` prints both for
  `ethereum-testnet-sepolia`, in two columns:

  | column | address | delivers when |
  |---|---|---|
  | `FORWARDER ADDRESS` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | a deployed workflow runs on the DON |
  | `MOCK FORWARDER ADDRESS` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` | `cre workflow simulate --broadcast` runs locally |

  Use the mock while settling from your own machine, the real one once the
  workflow is deployed and active. A receiver holds exactly one, so the two
  paths cannot both work against the same contract at the same time.

  Getting it wrong is the quietest failure in this system: every report reverts
  with `InvalidSender`, but the outer CLI transaction still succeeds and logs
  "Settled", because `route()` swallows the receiver-call failure into a
  `ReportProcessed(..., success=false)` event rather than reverting.

  This entry previously claimed the CLI printed `0xF8344CFd…` under "MOCK
  FORWARDER". Re-read from the CLI on 2026-09-18, the columns are as above —
  so check `supported-chains` yourself rather than trusting either this note or
  the skill's tables, which have also been wrong here.
- `WORKFLOW_AUTHOR` must be `0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa` — a fixed
  placeholder the CLI uses for the metadata's `workflowOwner` field when there is
  no linked owner key (`cre account list-key` → "No linked owners found"). Swap
  this for the real linked owner address once one exists.

### Check it landed, before trusting it

```bash
cre/preflight.sh staging
```

Reads every contract in `config.staging.json` and compares three values against
what the simulate path actually sends: the expected workflow name, the expected
author, and the forwarder. It then compares those same addresses against the
frontend's defaults in `config.ts`, which are kept in a second file with
nothing between them — a redeploy that updates one and not the other leaves the
app showing markets nobody settles. Read-only — no key, no transaction. Exit
status is 0 only when every row passes.

All three are worth a machine rather than an eye, because all three fail the
same way: the receiver reverts inside `onReport`, the forwarder swallows it into
`ReportProcessed(..., success=false)`, the outer transaction succeeds, and the
CLI prints "Settled" over a market that did not move.

**The name check is the one that is easy to get wrong by hand.** It is not
`keccak256`. `setExpectedWorkflowName` in `ReceiverTemplate.sol` takes
`sha256(name)`, hex-encodes it, keeps the first ten characters, and stores those
characters as `bytes10`. So `flight-settlement-staging` is `2de113ce6d`, stored
as `0x32646531313363653664`. This repo's own notes said keccak until
2026-08-19, which is exactly the sort of error a manual byte-for-byte
comparison confirms rather than catches.

## 3. Create market, stake both sides, fire the trigger

Both sides **must** be staked — a one-sided book voids in `_processReport`
regardless of the outcome the DON agrees on, which would mask a working
settlement path. Amounts are MockUSDC (freely minted) — they don't affect real
ETH spend, only the number of broadcast transactions does (~0.002 ETH for this
whole step at ~2 gwei).

```bash
export MARKET=<from step 2>
export TOKEN=<from step 2>
export YES_PK=<funded Sepolia key>
export NO_PK=<second funded Sepolia key>
export THRESHOLD=30
forge script script/CreateAndStake.s.sol:CreateAndStake --rpc-url https://ethereum-sepolia-rpc.publicnode.com --broadcast
```

Grab the `requestSettlement` tx hash from the broadcast JSON:

```bash
python3 -c "
import json
d = json.load(open('broadcast/CreateAndStake.s.sol/11155111/run-latest.json'))
print([tx['hash'] for tx in d['transactions'] if tx['function'] == 'requestSettlement(uint256)'][0])
"
```

## 4. Simulate the workflow, with a real on-chain write

```bash
cd cre
cre workflow simulate ./settlement --target staging-settings --broadcast \
  --trigger-index 0 --evm-tx-hash <hash> --evm-event-index 0 --non-interactive
```

**Do not trust the CLI's "Settled market N in tx ..." log line as proof of
success.** That log fires whenever the *outer* transaction's receipt status is
`1`, which happens even when `onReport()` itself reverted — `route()` catches
the failure and just records it. Verify against chain state directly:

```bash
cast call $MARKET \
  "markets(uint256)(string,string,uint32,uint16,uint64,uint64,uint8,uint8,bytes32,int32,uint256,uint256)" \
  0 --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Status `3` = Settled (or `4` = Void). Status `2` = still `SettlementRequested`,
meaning the write never actually landed — check the `ReportProcessed` event on
the forwarder (`0x15fC6ae9...`) for its `result` bool.

## Flight data source

`main.ts` calls **AeroDataBox** (`GET /flights/number/{iata}/{YYYY-MM-DD}`)
via RapidAPI. Schema (the `FlightContract`/`FlightStatus` shapes in
`fetchFlight`) is pulled verbatim from the live OpenAPI spec at
doc.aerodatabox.com, not guessed — see the comment above `fetchFlight` in
`main.ts` for the exact source.

### Setup

1. Sign up at RapidAPI and subscribe to AeroDataBox
   (https://rapidapi.com/aedbx-aedbx/api/aerodatabox) — free tier exists.
2. `cp cre/settlement/config.staging.example.json cre/settlement/config.staging.json`
3. Put the key in the **Vault DON**, not in the config:
   - add `CRE_SECRET_AERODATABOX_KEY=<key>` to `cre/.env` (gitignored)
   - `cre secrets create ./secrets.yaml --secrets-auth browser --target staging-settings`
     from `cre/`, in a real terminal — the browser sign-in needs a TTY
   - leave `apiKey` empty; `apiKeySecretId` is already `AERODATABOX_API_KEY`

   `--secrets-auth browser` matters: the default `onchain` mode reaches for the
   Ethereum mainnet registry, which this project does not use. Verified working
   2026-09-18 — the settlement of flight market 9 resolved its key this way.

   Filling `apiKey` instead still works, and is what the fallback in
   `resolveApiKey` is for, but config is handed to the DON: every node operator
   running the workflow can read whatever is in it.

`config.staging.json` is **gitignored**, not committed — same treatment as
`.env`. Config JSON values are passed through to the workflow verbatim (no
`${VAR_NAME}` substitution like `project.yaml`'s RPC urls get — confirmed by
running a real `cre workflow simulate` and reading back the literal string),
so there is no way to keep the key in a tracked file without it leaking into
git history. `config.staging.example.json` is the tracked template.

### Status mapping

AeroDataBox's `FlightStatus` enum collapses to the three states
`_processReport` already understands:

| AeroDataBox status | bucketed | outcome |
|---|---|---|
| `Canceled`, `Diverted` | `cancelled` | Yes (per contract rules) |
| `Arrived` | `landed` | Yes/No by `arrival.revisedTime - arrival.scheduledTime` vs threshold |
| `CanceledUncertain` and anything else (`Expected`, `EnRoute`, `Delayed`, …) | `airborne` | Void — no confirmed result |

Only `Arrived` computes a real delay; everything short of a confirmed
landing or cancellation voids rather than guessing.

**`CanceledUncertain` deliberately does not pay out.** AeroDataBox defines it
as "status of the flight is uncertain, may be cancelled" — a maybe, not a
fact — while the UI promises Yes for "cancelled or diverted". It originally
sat in the same branch as a confirmed cancellation and resolved markets to
Yes, paying real money on an unconfirmed signal. It now voids and refunds.
Not an edge case: **75 of 565 arrivals sampled at ORD (13%)** carried this
status.

### Verified against live data — three real bugs found this way

Tested with `cre workflow simulate` (no `--broadcast`, free) against real
flights. Cancelled ones were found by scanning airport schedules with
`withCancelled=true` — one call returns hundreds of flights, so finding a
genuine cancellation costs one request rather than dozens of guesses:

```bash
curl -s "https://aerodatabox.p.rapidapi.com/flights/airports/iata/LHR/2026-08-14T06:00/2026-08-14T18:00?direction=Departure&withCancelled=true" \
  -H "X-RapidAPI-Key: $KEY" -H "X-RapidAPI-Host: aerodatabox.p.rapidapi.com"
```

| market | flight | AeroDataBox status | result |
|---|---|---|---|
| 5 | BA286, 2026-08-13 | `Arrived`, 33 min early | `outcome=2 (No) delay=-33m` |
| 6 | BA286, 2026-08-14 | `EnRoute` | `outcome=3 (Void)` |
| 7 | BA143, 2026-08-14 | `Canceled` | `outcome=1 (Yes)` |
| 8 | DL1880, 2026-08-14 | `CanceledUncertain` | `outcome=3 (Void)` |

`Diverted` remains untested — none found across ~800 flights sampled at JFK
and ORD; genuine diversions are rare. It shares the `Canceled` branch
exactly, so the logic is covered even though that specific enum value has not
been seen live.

Three bugs showed up only against real data — the mock never exercised any of
these paths:

1. **AeroDataBox timestamps aren't RFC 3339** — `"2026-08-14 12:55Z"` (space,
   no seconds). `Date.parse` on this is implementation-defined: V8 (bun, used
   for local typechecking) accepts it; the workflow's actual WASM/QuickJS
   runtime returned `NaN`. Replaced with a small regex parser feeding
   `Date.UTC`'s numeric-argument form, which has no string-format ambiguity
   to disagree about.
2. **A genuine QuickJS runtime bug in mixed `number`/`bigint` comparison for
   negatives.** Once market 5 fixed #1, encoding the report threw
   `IntegerOutOfRangeError` for `delayMinutes = -33` on an `int32` field —
   comfortably in range. Traced into viem's `encodeAbiParameters` and
   confirmed directly in the real runtime: `-33 < -2147483648n` evaluated to
   `true`. `delayMinutes` is now passed as a `BigInt` (typed around with a
   documented cast, since viem's type-level ABI mapping expects `number` for
   int32) so the comparison is bigint-vs-bigint on both sides.

3. **`CanceledUncertain` was paying markets out** — see "Status mapping"
   above. Found while hunting for a real cancelled flight to test the
   disrupted branch.

All three fixes are in `main.ts`, with comments at the fix site pointing back
to this.

## Two independent sources

`ConsensusAggregationByFields` runs per node and protects against a dishonest
or broken *node*. It cannot protect against a wrong *source*, since every
node queries the same one. Setting `secondaryUrl` in the config adds a second
provider; empty string runs single-source.

**Sources are compared by outcome, not by value.** Two sources reporting 44
and 46 minutes against a 45-minute threshold are barely two minutes apart,
but they disagree about who gets paid — averaging them would manufacture an
answer neither source gave. `outcomeFor` is applied per source and the
results must match; if they don't, the workflow throws and the market voids,
refunding everyone. Only once the outcomes agree is the median taken, and any
remaining spread is noise within one side of the threshold.

Verified against market 5 (BA286, AeroDataBox reports `Arrived` 33 min
early), using the mock gist as a controllable second provider:

| secondary says | result |
|---|---|
| `landed`, −33 min (agrees) | `outcome=2 (No)` — settles normally |
| `landed`, +90 min (Yes vs No) | **Void** — `Sources disagree on outcome ... landed/-33m->2 vs landed/90m->1` |
| `airborne` vs a `Canceled` flight | **Void** — disagreement on status, not just delay |

A real second provider needs its own key and a `readAeroDataBox`-sized
adapter function; nothing below that layer changes. The secondary contract is
deliberately minimal (`{ status, arrivalDelayMinutes }`) so the existing mock
gist can serve as a controllable stand-in for testing — which also restores
the deterministic on-demand testing the AeroDataBox switch had cost.

## Crypto markets

`CryptoMarket.sol` — "will BTC/ETH be at or above $X at time T?", parimutuel,
settled by the same workflow through a second log trigger. Deployed at
`0x8DA11eb17D5F3f4427aA3017E95e50b132A210be`, sharing MockUSDC with the flight
market so one balance covers both.

Prices carry **8 decimals**, matching the Chainlink convention: a $63,000.00
strike is `6300000000000`.

### Why not Chainlink Price Feeds

The obvious answer for a crypto price is a Data Feed, and it is the wrong one
here. Measured directly on Sepolia, BTC/USD and ETH/USD update on a **flat
60-minute heartbeat** with no deviation trigger — six consecutive rounds, all
exactly 60 minutes apart:

```bash
cast call 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43 \
  "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" <roundId> \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

A 5-minute market read from that feed would compare a price against *itself*
roughly 92% of the time, always resolving No. The market would be rigged by
data cadence rather than by anyone's intent. Sub-hour horizons need real-time
exchange data, which is what the workflow fetches.

### Three USD venues, and why not Binance

Coinbase, Kraken and Bitstamp — all keyless, HTTPS, all quoting **USD**.
Binance is deliberately excluded: its liquid pair is BTC/**USDT**, and pricing
a USD market off a Tether pair adds a systematic basis rather than independent
signal. Measured on one minute of live data, Binance sat ~$70 (0.11%) away
while the three USD venues agreed within ~$8 (0.013%).

### One-minute candles, not spot quotes

Each venue is asked for the **close of the one-minute candle containing
expiry**, never a live quote. Spot would hand each DON node a different number
depending on the millisecond it asked, so consensus could never be exact. A
closed historical candle is the same value for every node however far apart
they run.

That is also why `CryptoMarket` holds settlement back `SETTLEMENT_DELAY` (60s)
past expiry: the candle does not exist until its minute is over, and settling
at expiry itself would send the workflow looking for unpublished data and void
the market for no reason.

Venues are reconciled by **outcome versus the strike**, not numeric closeness
— the same rule as the flight path, for the same reason: two venues a few
cents apart either side of the strike disagree about who gets paid.

### Never ask a venue for exactly the candle you want

Market 4 voided in production with `Coinbase has no candle for minute
1786816800` — a minute that had traded 1.04 BTC and that a wider request
returns without complaint. The request was for exactly `[T, T+60]`, and
Coinbase returns an **empty array** for that shape, reproducibly.

Measured over 114 requests across both products:

| window | candle missing |
|---|---|
| `[T, T+60]` | always |
| `[T-60, T+60]` | 8% |
| `[T-300, T+300]` | never |

So every venue is now asked for a **span** and searched for the exact minute,
never trusted to return the bucket requested. The wide Coinbase response is
~650 bytes, far inside the 250kb simulation limit, so the margin is free.
Bitstamp's `limit=1` anchored on `T` was the same bet and was widened too —
it had not failed, but its failure mode is identical: a market voided on data
that exists.

Kraken looks flaky if you loop over it quickly; that is its public rate limit,
not missing data. One call per settlement is fine.

### Verified end to end

Two markets created with the same expiry, one struck below spot and one above,
both sides staked, settled together against live venue data:

| market | strike | result | on chain |
|---|---|---|---|
| 2 | $50,000 | `outcome=1 (Yes)` | status 3, observedValue `6297370000000` |
| 3 | $80,000 | `outcome=2 (No)` | status 3, same observed price |

Both confirmed by reading `core(id)` directly and by `ReportProcessed = true`
on the forwarder — not from CLI output.

```bash
# create + stake both sides of both markets
forge script script/CreateCryptoMarkets.s.sol:CreateCryptoMarkets \
  --rpc-url $SEPOLIA_RPC_URL --broadcast
# then, once SETTLEABLE_AT passes, requestSettlement and:
cre workflow simulate ./settlement --target staging-settings --broadcast \
  --trigger-index 1 --evm-tx-hash <hash> --evm-event-index 0 --non-interactive
```

`--trigger-index 1` selects the crypto handler; `0` is still the flight one.

Keep `EXPIRY_IN` generous (default 300s). `block.timestamp` in the script is
read during forge's simulation pass, but its ten transactions then broadcast
one per block — roughly two minutes. Too short a window and the stakes land
after `closeTime` and revert with `TooLate`, leaving empty markets that can
only void. That happened on the first run at 90 seconds.

### The standing slate

`CreateCryptoSlate.s.sol` creates the product slate rather than a settlement
test: BTC and ETH at **5 minutes, 15 minutes and 1 hour**, one strike per asset
set just off spot so the questions are genuinely open, the same strike across
all three horizons so the implied odds fan out with *time* rather than level.

```bash
BTC_STRIKE=63000 ETH_STRIKE=1882 STAKE_WINDOW=480 \
forge script script/CreateCryptoSlate.s.sol:CreateCryptoSlate \
  --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
```

Staking closes for every market at one shared `closeTime`, well before the
shortest expiry. That is the whole point of `closeTime` being separate from
`expiryTime`: with the book open right up to expiry, anyone could stake a
second before the price is read and take the pot off people who committed
early. `STAKE_WINDOW` must clear how long the script takes to land — 22
transactions at one per block is about four and a half minutes.

Settled against live venue data:

| market | asset | horizon | strike | observed | outcome |
|---|---|---|---|---|---|
| 4  | BTC | 5 min  | $63,000 | — | **Void** — the Coinbase window bug above |
| 10 | BTC | 5 min  | $63,000 | $63,020.26 | Yes — same path, after the fix |
| 5  | BTC | 15 min | $63,000 | $63,023.01 | Yes |
| 6  | BTC | 1 hour | $63,000 | $62,981.00 | No |
| 7  | ETH | 5 min  | $1,882  | $1,882.40  | Yes |
| 8  | ETH | 15 min | $1,882  | $1,883.25  | Yes |
| 9  | ETH | 1 hour | $1,882  | $1,881.13  | No |

Market 10 exists because market 4 died of the Coinbase bug; it re-ran the exact
5-minute BTC path that failed, and settled.

The slate did the thing it was shaped to do: with one strike per asset held
across all three horizons, both assets resolved Yes at 5 and 15 minutes and No
at an hour. Same question, same strike, opposite answer purely from how far out
it was asked — which is the property a single-horizon slate cannot show.

A strike set *exactly* at spot is the one place venues are most likely to
straddle the line and void the market — at one sampled minute the three venues
were $0.40 apart but sat either side of $1,882. Genuine behaviour, not a fault,
but worth knowing when choosing a strike for a demo.

### Mock gist (kept for deterministic testing)

The original mock is still useful for exercising all three outcomes on
demand, without depending on a real flight's timing. It no longer matches
`main.ts`'s expected response shape (`fetchFlight` now parses AeroDataBox's
`FlightContract`, not `{status, arrivalDelayMinutes}`) — reviving it would
mean pointing `apiUrl` at a small shim that returns AeroDataBox-shaped JSON,
or keeping a second workflow variant around. Not done, since it wasn't asked
for; noting the option here in case deterministic on-demand testing is
needed again later.

Public gist: https://gist.github.com/Wnbj/c0d43e5e48303654c2c5219d815495e4

Historical results, from when `main.ts` still spoke the mock's shape — all
three re-verified end-to-end on the `ReceiverTemplate`-based contract on real
Sepolia (contract `0x09068efb21fabeac59694e01428cf438cf38e2b3`), confirmed
via direct `cast call` on-chain state:

| market | outcome | on-chain status | on-chain outcome |
|---|---|---|---|
| 0 | Yes (delay 42) | 3 (Settled) | 1 |
| 1 | No (delay 15)  | 3 (Settled) | 2 |
| 2 | Void (airborne) | 4 (Void)   | 3 |

## Stock and commodity markets

`StockMarket.sol` — "will CSPX be at or above $X at time T?", settled from a
**Chainlink Data Feed** instead of exchange APIs. Deployed at
`0x451bcdB90EC6f6F5f40B5B2578aef641e36b71ca`, same MockUSDC as the others.

### Why a feed here, when the crypto market refuses one

The objection was never feeds, it was cadence. BTC/USD on Sepolia publishes on
a flat 60-minute heartbeat, so a 5-minute market read from it compares a price
against itself. CSPX/USD publishes about daily, and an equity market's natural
horizon is a session. Same instrument, opposite verdict, because the question
is on a different timescale.

There are **no single-stock feeds on Sepolia** — no AAPL, no TSLA. What exists
(all verified live before being registered):

| symbol | what it is | heartbeat |
|---|---|---|
| CSPX | iShares Core S&P 500 UCITS ETF, USD | ~daily |
| XAU | gold, USD | hourly |
| IB01 | iShares $ Treasury Bond 0-1yr ETF, USD | ~daily |

CSPX is the closest honest thing to an equity market there: the S&P 500 in one
number.

### Reads are pinned to a block

Every DON node runs the workflow independently. Reading `latestRoundData()` at
"latest" gives each node whichever chain head it happened to see, the report
bytes differ, and consensus fails — the same problem that ruled out spot quotes
for crypto. The trigger log carries its own block number, so every node already
shares one agreed reference point; all feed reads pin to it.

### The trading calendar is the hard part, not the price

A feed keeps publishing when the exchange behind it is shut. It simply repeats
the last price with a fresh timestamp. Measured on Sepolia:

| feed | observation |
|---|---|
| CSPX/USD | answer changed on **every** weekday round; **unchanged** Friday → Saturday |
| XAU/USD | **4,377.25 for twelve consecutive hourly rounds** across a Saturday |

So a market expiring while the exchange is closed is decided the moment the
bell rings, and anyone staking afterwards is betting on a known result. The
chain cannot know an exchange calendar — but it can notice that nothing
happened. The workflow therefore **voids unless the answer actually changed
between `closeTime` and `expiryTime`**, which is why `SettlementRequested`
carries both. It also voids on a round older than the market's own
`maxStaleness`, which is per market because a daily feed and an hourly one
cannot share a threshold.

### The trading window is bounded by the feed's publication rate

A stock settlement makes TWO round lookups — the round in force at expiry, and
the round in force at the close — and walks backwards one round per read from
the latest one. Both walks share a single budget of **15 chain reads per
execution** (`ChainRead.CallLimit`), and three of those are spent before the
walking starts.

So the real limit is not a duration. It is **how many feed rounds separate the
latest one from `closeTime`**, and that depends entirely on the feed:

| feed | publishes about | usable close-to-expiry gap |
|---|---|---|
| BTC/USD, Sepolia | once an hour | ~12 hours |
| CSPX, Sepolia | once a day | ~12 days |

Measured 2026-09-20: a BTC market with `closeTime` 24 hours before expiry
voided on every one of the ten DON nodes with

```
Resolution failed, voiding stock market 3: Error: Out of chain reads (limit 15 per execution)
```

**The void carries no reason on chain.** `observedValue` is 0 and the status is
Void, exactly as for a genuine "the price did not move" refusal — the reason
lives only in `cre execution logs <id>`, per node. So a market that is too long
for its feed looks identical to one that was already decided.

Before creating a long-dated equity market, read the feed's cadence rather than
assuming it:

```bash
cast call $FEED 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url $SEPOLIA_RPC_URL
# then walk back a few ids and diff updatedAt — note the ids are phase-encoded
# uint80, so do the arithmetic in python, not in the shell.
```

Reserve markets are exempt: they carry no `closeTime` and make one lookup, not
two.

### Feeds are allowlisted

`newMarket` is permissionless. If the feed address came from the caller, anyone
could create a real-looking market pointing at a contract they control and hand
themselves the settlement price. The owner registers feeds; callers pick one by
symbol, and that symbol is what labels the market in the UI.

```bash
forge script script/DeployStock.s.sol:DeployStock \
  --rpc-url $SEPOLIA_RPC_URL --broadcast
# then, once settleAfter passes, requestSettlement and:
cre workflow simulate ./settlement --target staging-settings --broadcast \
  --trigger-index 2 --evm-tx-hash <hash> --evm-event-index 0 --non-interactive
```

`--trigger-index 2` selects the stock handler. The full list, with every
contract address in `config.staging.json` populated:

| index | handler |
|---|---|
| 0 | flight log |
| 1 | crypto log (also serves AMM — same event) |
| 2 | stock log |
| 3 | reserve log |
| 4 | cron sweep, flights |
| 5 | cron sweep, crypto |
| 6 | cron sweep, stocks |

**These numbers are positions in a list built at runtime, not fixed ids.**
`initWorkflow` pushes a handler only when its contract address is non-empty
(`main.ts`), so emptying `reserveContractAddress` moves every sweep down by
one. This table has already been wrong once for exactly that reason — the
reserve handler was added at position 3 and the sweeps shifted underneath the
line that used to say 3/4/5.

**The table is now asserted by a test** (`describe("trigger indices")` in
`cre/settlement/settlement.test.ts`), which calls the real `initWorkflow` and
compares handler identities rather than restating the rule. Insert a handler
and the suite fails, so this table has to move in the same commit. Confirmed
both ways: adding one breaks two tests, removing it restores 44 green.

### Verified against historical feed rounds

`newMarket` does not require future timestamps, which makes a backtest possible:
create a market whose close and expiry are already in the past and it is
settleable immediately, against feed rounds that really happened. Staking
reverts with `TooLate`, so the book stays empty and the contract voids on
payout grounds — but `outcome` and `observedValue` are still written, which is
exactly the part being tested. Far better than waiting an hour to discover the
round walk was wrong.

Market 2, close `1786814870`, expiry `1786818470`, strike $62,000:

| what | value |
|---|---|
| pinned block | 11496208 (the settlement-request block) |
| round in force at close | 16:46:24 → `6302552471078` |
| round in force at expiry | 17:46:48 → `6299976883013` |
| moved between the two? | yes, so not voided |
| on chain | `outcome=1 (Yes)`, `observedValue=6299976883013` |

The observed value matches the 17:46:48 round exactly — the last one published
at or before expiry — confirming the walk landed on the right round rather than
on `latest`.

### Verified live, not just backtested

Market 1 — the same BTC feed, real future expiry, both sides staked — settled
an hour later against a round that had not been published when the market was
created: `outcome=1 (Yes)`, `observedValue=6304701036297` ($63,047.01) vs a
$63,000 strike, in tx
`0x1743badf35a3fe29175c78527311d20194e4fa21792178db0910e0115e490ecf`.

## The reconciliation sweep (cron trigger)

The log-trigger design has a hole that has nothing to do with the code: **it
needs someone to emit the log**. Every settlement in this project began with a
human calling `requestSettlement()`. If the workflow was down when the event
fired, or the settlement reverted, the market simply stays stuck — no second
log is coming.

`onSweep` is a further handler on a **cron trigger** (`cron-trigger@1.0.0`,
already in the SDK) — three of them now, one per market family. Each reads its
market contract directly and settles
anything sitting in `SettlementRequested`, through the *same* settle functions
the log handlers call — so a market settled by the sweep can never resolve
differently from one settled by the trigger.

```bash
# 4 = flights, 5 = crypto, 6 = stocks. See the table under "Stock and
# commodity markets" for why these are positions, not fixed ids.
cre workflow simulate ./settlement --target staging-settings --broadcast \
  --trigger-index 4 --non-interactive
```

It paid for itself on the first run, finding three flight markets (6, 7, 8)
left stuck in `SettlementRequested` by earlier sessions and settling all three.

### Pinned to finalized, and why that sets the schedule

A cron tick has no log to take a block from, and reading at `latest` would hand
every DON node a different chain head — different report bytes, failed
consensus. So every sweep read pins to the **last finalized block**, the one
view of the chain nodes converge on without coordinating.

That has a cost, and the first run demonstrated it. Finalized state lags:

```bash
cast block finalized --rpc-url $SEPOLIA_RPC_URL   # measured: 86 blocks / 17m12s behind latest
```

Run the sweep again a minute later and it sees the markets it just settled as
still stuck, and settles them again. The contract rejects the duplicate —
`ReportProcessed = false` on the forwarder, verified on the receipt — so
nothing corrupts, but each retry burns a transaction.

**The sweep period must therefore exceed the chain's finality lag.** At the
initial five minutes that was three wasted writes per market; the schedule is
now every 30 minutes, comfortably above the measured 17. Going faster would
mean reading unfinalized state, trading determinism for latency — the wrong
trade for a safety net, when the log trigger is already the fast path.

Measured concretely on the run that exposed this: the settlements landed in
blocks `11497177`–`11497180`, and eight minutes later `finalized` was still at
`11497135` — 42 blocks short. Re-running the sweep in that window found and
re-settled the same three markets, and the contract rejected all three. Do not
judge whether a sweep worked by re-running it; read the contract.

### 15 chain reads per execution — the limit that reshaped this

The first working sweep aborted partway through:

```
[101]LimitExceeded: capability call limit exceeded for evm.CallContract:
PerWorkflow.ChainRead.CallLimit ... cannot use 16, limit is 15
```

`cre workflow limits export` gives the real production numbers, and they are
worth reading before designing anything that touches the chain:

| limit | value |
|---|---|
| `ChainRead.CallLimit` | **15 per execution** |
| `ChainRead.LogQueryBlockLimit` | 100 blocks |
| `TriggerSubscriptionLimit` | 10 |
| `ChainWrite.TargetsLimit` | 10 |

Two things followed from it.

**One sweep became three.** A single handler walking three contracts cannot fit
in 15 reads. Separate triggers are separate *executions*, so each contract now
has its own cron handler and its own allowance — flights at trigger index 3,
crypto at 4, stocks at 5. Six triggers total, against a limit of 10.

**It exposed a bug in code that already worked.** `MAX_ROUND_WALK` was 24, and
a stock settlement walks the feed twice — once back to expiry, once on to
close. Worst case `1 + 24 + 24 = 49` reads against a hard limit of 15. Live
settlements had passed only because real walks were one or two steps. Every
read now draws from an explicit `ReadBudget` that throws when exhausted, so
the failure is a voided market with a clear reason rather than a killed
execution.

Budget per sweep, worst case, all fitting in 15:

| sweep | header | count | scan | terms | feed walk |
|---|---|---|---|---|---|
| flights | 1 | 1 | 13 | — | — |
| crypto | 1 | 1 | 11 | 2 | — |
| stocks | 1 | 1 | 6 | 1 | 6 |

Stocks settle at most one market per run for this reason; a second waits for
the next tick, which is the right answer for a safety net.

### Verified: the backlog it cleared

Run against the live contracts, the sweeps found and settled every market that
had been left stuck across previous sessions:

| market | found by | result |
|---|---|---|
| flight 6 | flight sweep | No, landed 6m late |
| flight 7 | flight sweep | Yes, cancelled |
| flight 8 | flight sweep | Void, still airborne |
| flight 5 | flight sweep | No, landed 33m early |
| crypto 11 | crypto sweep | **Yes**, $63,041.19 vs $63,000 — both sides staked, pays out |
| crypto 12 | crypto sweep | Yes, $63,080.18 (no stakes, so Void on payout) |

A final pass reported `nothing stuck` on all three contracts, confirmed by
reading every market's status directly rather than by trusting the log.

### What it does not fix

The sweep removes the human from *running the workflow*. It does not remove the
human from *calling `requestSettlement()`* — a CRE workflow's only on-chain
write is a signed report to `onReport()`, so it cannot make that call. Full
autonomy needs `_processReport` to accept a report for any market past
`settleAfter`, dropping the request step entirely. That is a change to
`ParimutuelMarket`, so it lands whenever the contracts are next redeployed;
`requestSettlement` exists only to give a log trigger something to listen to,
and adds nothing to authorisation, which is already forwarder + author +
workflow name.

## Why flights are not on the DON

Every other family migrated on 2026-09-20. Flights did not, and the reason is
not the secret — it is arithmetic.

**A DON is ten nodes, and every one of them makes the HTTP call.** That is what
consensus over an off-chain read means. For the crypto path it costs nothing,
because the load is spread over three public venues that tolerate it and only
two of the three need to answer. For flights there is one provider on a free
RapidAPI tier, and ten simultaneous requests are nine too many.

Measured 2026-09-20, a single settlement — not a sweep:

```
Errors received: [HTTP 429 for BA286, HTTP 429 for BA286, ... ]   (nine of them)
ConsensusFailed: received 9 errors which is >= f+1 (4)
Market 11 -> outcome=3 delay=0m status=unavailable
```

One node got an answer. Nine were refused, consensus failed, and the market
voided. **This is a per-settlement problem, so `sweepSchedule` was never the
thing to worry about** — the sweep only multiplies something that already does
not work.

`readAeroDataBox` has no retry: `sendRequest(...).result()` and a non-200
throws. Whether a retry with per-node jitter would clear a burst limit is
untested, and so is whether the SDK offers any way to delay inside a node
function at all. The other lever is `secondaryUrl`, which the config already
carries and which is empty — a second independent provider halves the load on
each.

### Proving a handler on the DON without the one-way step

The migration itself is irreversible per contract: a receiver holds ONE
forwarder, so the moment it trusts the production one, `simulate --broadcast`
can no longer reach it. The finding above was made WITHOUT taking that step,
and the sequence is worth reusing for any future handler:

1. Put the contract's address in the production config and redeploy. The
   workflow starts watching it; the contract still trusts the mock forwarder.
2. Create a market and request settlement. The DON runs the handler end to
   end — secrets, HTTP, consensus, report, chain write.
3. The receiver refuses, because the forwarder is the wrong one. The
   transaction still succeeds and carries exactly one log:
   `ReportProcessed(result = false)` from `0xF8344CFd…`, and NO `Settled`.
   The market's status does not move.
4. Read `cre execution logs <id>`. Everything up to the refusal is real.

Cost: one throwaway market and one redeploy. It turns "flip it and find out"
into a measurement.

**Allow several minutes between a redeploy and the first trigger.** A request
34 seconds after a deploy produced no execution at all — not a failure, no
record anywhere. The same request 6 minutes later fired in 4 seconds. A log
trigger that was not yet registered when the log was mined misses it
permanently; waiting afterwards does not recover it.

## Secrets: the API key is currently in the clear

`config.staging.json` carries the RapidAPI key as plaintext. That file is
gitignored, but the config is **handed to the DON**, so every node operator
running this workflow can read the key. Fine for a POC on a free tier; not
fine for anything with a bill attached.

The SDK has the fix: `runtime.getSecret({ id, namespace })` resolves a value
from the Vault DON, so it never appears in config. `resolveApiKey` in `main.ts`
uses it when `apiKeySecretId` is set and falls back to `apiKey` otherwise, so
the existing verified path is untouched until the secret exists.

**It has not been exercised, and activating it is not free.** `cre secrets list`
fails with:

```
failed to create workflow registry client: failed to create client for chain
"ethereum-mainnet": rpc url not found for chain ethereum-mainnet
```

The workflow/secrets registry lives on **Ethereum mainnet**. Using it needs a
mainnet RPC in `project.yaml`, and `cre secrets create` is a real mainnet
transaction that uploads the key to the Vault DON — real gas, and a credential
leaving this machine. Both are decisions for the account owner, so the code
path is in place and the upload is deliberately not done.

A further step after that is the **confidential HTTP** capability
(`networking/confidentialhttp`), which templates the secret into the request on
the node rather than passing it through workflow memory as a string.

## Reserve markets (Proof of Reserve / fund NAV)

`ReserveMarket.sol` at `0xa768Be2741A0464b81606649eCa45bfF7aD4d939`, with stETH
Proof of Reserves, USDW Reserves and USTB NAV registered.

**A separate contract from StockMarket, not a flag on it.** StockMarket voids
unless the feed's answer changed between close and expiry — right for an
equity, where an unchanged answer over a session means the exchange was shut.
A reserve has no session: deposits and redemptions land at any hour, and
reserves sitting still for a day is ordinary rather than proof the outcome was
already fixed. ReserveMarket does not even emit `closeTime`, so the workflow
cannot apply that check by accident. **Staleness is the load-bearing guard
here**, so `maxStaleness` should be set tight against the feed's heartbeat.

Splitting by contract also avoided orphaning the live CSPX market, which has
stakes on it and settles Monday; redeploying StockMarket would have taken it.

### Feeds do not agree on decimals

Assuming 8 is wrong in both directions, measured on Sepolia:

| feed | decimals | raw answer | read as 8 decimals |
|---|---|---|---|
| CSPX/USD | 8 | `83869000000` | correct |
| USTB NAV | 6 | `11177748` | $0.11 instead of $11.18 |
| stETH PoR | 18 | `9505650857465828722927470` | **does not fit uint64 at all** |

The workflow reads `decimals()` from the feed and normalises to the 8 that
strikes, reports and the UI all use. **Movement is still checked on the raw
answers**, before rescaling — an 18-decimal feed can move in a digit that
normalising truncates away, and truncation must never turn a real move into
"nothing happened".

Verified against real rounds: the stETH answer settled to `950565085746582`,
or 9,505,650.85746582 tokens, which is what the feed reports.

The same three assumptions were wrong in the frontend and were fixed with it:
`PriceChart` looked for a feed on `stocks` only so reserve markets got no chart
at all; the chart divided every answer by `1e8`; and values were formatted with
a `$` when a reserve level is a count of tokens, not dollars.

## AMM markets — a locked price instead of a pool

`AmmMarket.sol` at `0xdc866C24Af158E55C1c424dc81d69f9F668dF27a`.

In the parimutuel contracts you do not buy at a price, you join a pool: your
share of the pot is fixed only at settlement, so every later stake on your own
side dilutes you through nothing you did. Here a buy gives you a fixed number
of shares, each redeemable for one unit of collateral if you are right. Your
price is what you paid.

### Solvency is structural, not tested-for

Collateral only enters by minting **complete sets** — one unit in mints one YES
and one NO — so at all times:

```
totalYesShares == totalNoShares == collateral held
```

Every share, in the pool or in a wallet, is backed by its own unit. Buys use
ceiling division so the constant product may only grow: any rounding error
favours the pool, never the buyer.

### The bug the fuzz suite could not see

The first version paid **both** sides a full unit on a void. One unit of
collateral mints one YES *and* one NO, so honouring both at par promises two
units for every one held — the test failed with `ERC20InsufficientBalance`.

The fuzz suite missed it because it only fuzzed Yes and No, and those only ever
pay one side. The void case had to be fuzzed for it to surface.

A void now pays **half a unit per share, either side** — the only split that
keeps the invariant and treats both sides alike. It is deliberately **not a
refund**: someone who bought YES at 70 cents gets 50 back. Share balances do
not record what anyone paid, so a true refund is not recoverable from them and
pretending otherwise would be insolvent.

### Any number of liquidity providers, who are the counterparty

Providers are the other side of every trade. If traders were right, the pool is
left holding mostly the losing side and providers recover less than they put in;
that shortfall is exactly what funded the traders' profit, and it is bounded by
what they supplied.

`addLiquidity` scales BOTH reserves by `d / max(Y, N)`, which is the only way to
add depth without moving the price, and mints LP shares in proportion. Because a
deposit mints complete sets while the pool can only absorb them in its own
ratio, the depositor keeps the remainder as a real directional position — the
same thing that happens to a creator opening away from even money, and the part
of providing liquidity people do not expect, so the UI quotes it explicitly.

After settlement each provider draws `winningReserve * shares / total`, floored,
so the sum can never exceed what the pool holds; rounding strands at most a unit
per provider. Withdrawal is **post-settlement only** — no remove-while-open,
which is where the silent mistakes live.

A provider therefore has **two independent claims**, with two separate one-shot
guards: `withdrawLiquidity` for the pool, `redeem` for the residual shares.
Neither consumes the other, which is why the UI offers two buttons.

### The trading fee, retained as complete sets

`feeBps` is fixed per market at creation, bounded at 500, and never changeable —
it is a term the trader read in the quote. The fee is not moved anywhere: the
full amount is minted into complete sets and the fee simply stays in both
reserves, which raises the constant product and therefore the value of every LP
share. Two properties fall out of that rather than needing machinery:

- **Outcome-independent.** Whichever side wins, the winning reserve carries the
  fees with it; on a void, `(f + f) / 2` is still `f`.
- **Late providers cannot claim earlier fees.** Fees inflate the reserves
  without minting shares, so a later deposit buys proportionally fewer of them.

`quote`/`quoteSell` route through the same `private pure` helpers as
`buy`/`sell`. That is not tidiness: the UI turns those quotes into a hard 1%
slippage bound, so a fee computed even one rounding step differently shows up as
trades that fail for no visible reason — or gets absorbed silently inside the
bound and never noticed.

### Settlement reuses the crypto handler

`SettlementRequested` is byte-identical to CryptoMarket's, so this contract
joins that trigger's **address list** rather than needing a handler of its own.

That exposed a latent bug: the handler wrote its report back to a *config*
address, which would have delivered one contract's result to the other. It now
replies to the contract the log came from.

### Selling: the exit that makes a locked price mean something

Without it you can enter a position and then only wait, which is a bet with
extra steps rather than a market. A sale is the mirror of a buy: shares go back
into the pool, and enough complete sets are burned to restore the constant
product. Solving `(Y + s - c)(N - c) = k` for the payout gives

```
c = [ (Y + N + s) - sqrt( (Y + N + s)^2 - 4·s·N ) ] / 2
```

with the OPPOSITE reserve inside the discriminant — `N` selling YES, `Y`
selling NO.

**The rounding direction is the whole game.** `sqrt` must be rounded UP so the
payout rounds down and the remainder stays with the pool. Checked numerically
before a line of Solidity was written: with a floored root the product SHRANK
on every trade — the pool overpaying slightly each time until it could not pay
at all. Verified again by flipping it back in the finished contract, where six
tests fail.

```bash
forge script script/DeployAmm.s.sol:DeployAmm --rpc-url $SEPOLIA_RPC_URL --broadcast
```

Live on Sepolia: opened at `5000` bps, a 3 mUSDC buy returned exactly the
quoted 5,307,692 shares — 56.5 cents each — and moved the price to `6282`.

## Strike ladders

One question at one expiry, across several strikes — the shape Kalshi shows as
an "event" with rungs beneath it. Live example: BTC at 17:30, five strikes
$250 apart.

**No contract change was needed, and none should be.** A ladder is N markets
sharing an asset and an expiry and differing only in strike, so membership is
DERIVED in `lib/events.ts` rather than stored:

```
`${categoryId}:${contract}:${asset}:${expiryTime}`
```

That makes it work retroactively on ladders created before the code existed,
and it is also the honest definition — markets over the same thing resolving at
the same instant *are* the same question.

`OPEN_BPS` is required and must have one entry per rung — the script refuses a
mismatch rather than seeding a ladder at the wrong shape. `FEE_BPS` is optional
and defaults to 30.

```bash
AMM_MARKET=0x63Dd... TOKEN=0xcd12... STRIKE_LOW=62500 STRIKE_STEP=250 RUNGS=5 \
OPEN_BPS=8500,7000,4500,2500,1200 FEE_BPS=30 \
forge script script/CreateLadder.s.sol:CreateLadder --rpc-url $SEPOLIA_RPC_URL --broadcast
```

### On the AMM, not a parimutuel contract

A ladder is only worth anything if every rung has a price: 45% alone says
little, but 85 / 70 / 45 / 25 / 12 across rising strikes is the market's whole
view of where the price will land. An AMM quotes a price from the moment it
opens; parimutuel rungs read "no odds yet" until somebody stakes, so a ladder of
five of them is a column of blanks.

### Ladders open at real prices, not at even money

`newMarket` takes an opening price. The pool holds reserves in the ratio
`(1-p):p` and the creator keeps the remainder of the other side — a real
position, which is what having a view means. `addLiquidity` does the same
arithmetic against the reserves as they stand, which is why a later deposit
also hands its provider a position rather than pure exposure to volume.

Before this, seeding always minted equal reserves, so every rung opened at 50%
whatever its strike. Five rungs all reading 50% say nothing; the shape IS the
information. The only way to get one was to trade each rung by hand at
`L·(sqrt(p/(1-p)) - 1)`, which cost ~178 mUSDC against 200 of liquidity, and
the far strikes cost multiples of the near ones — exactly backwards.

The live ladder is now seeded straight to these prices with no trades at all,
landing on each target exactly:

| strike | yes | no |
|---|---|---|
| $62,500 | 85% | 15% |
| $62,750 | 70% | 30% |
| $63,000 | 45% | 55% |
| $63,250 | 25% | 75% |
| $63,500 | 12% | 88% |

The creator ends up holding 32.94 YES at the $62,500 rung and 34.55 NO at the
$63,500 one — long whichever side they priced as likely, at both ends. Quoting
a price is not free, and it no longer looks free.

### Which rung the card shows

The one closest to even odds, not the middle strike. The near-certain rungs at
either end carry almost no information, and which strike sits in the middle is
an accident of how the ladder was laid out — while which one is closest to 50%
is what the market currently believes.

Ladder cards also recover a shared title by stripping the price out of the
featured rung's question, because every question embeds its own strike and
there is no event title on chain.

## Tests

| suite | count | command |
|---|---|---|
| contracts | 170 | `cd contracts && forge test` |
| frontend | 142 | `cd frontend && bun run test` |
| workflow | 35 | `cd cre/settlement && bun test` |

The frontend and workflow suites were added after a routing bug reached a
user: writes branched on `categoryId` with the flight contract as the else, so
every stock stake was delivered to FlightMarket and landed on a real,
unrelated market. It passed typecheck, passed build, passed manual browser
testing. The tests were confirmed by reintroducing it — three fail, with
`expected 2 to be 3` on the count of distinct destinations.

## Appendix: free local rehearsal via anvil fork

Before spending real Sepolia ETH, the same flow can run against a local anvil
fork of Sepolia (same chain id 11155111, so the CRE simulator treats it as
Sepolia). Useful for iterating on `main.ts` without gas cost, but **cannot**
exercise the real `onReport` path — anvil has no `MockKeystoneForwarder`
deployed at `0x15fC6ae9...` unless you deploy one yourself, and
`simulate --broadcast` against a fork you don't control the forwarder on will
just fail to route.

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8545
# then run Deploy.s.sol / CreateAndStake.s.sol against --rpc-url http://localhost:8545
# with any anvil default private key, and cre workflow simulate (no --broadcast)
# against the resulting requestSettlement tx hash.
```

## Known gaps

- **Deploy access is not enabled for this account**, so the workflow itself has
  never been registered with a real Chainlink DON via `cre workflow deploy`.
  Everything above runs through `cre workflow simulate`, which executes the
  workflow logic locally and (with `--broadcast`) submits the resulting write
  for real — but there is no live DON reaching consensus across independent
  nodes. The `FORWARDER`/`WORKFLOW_AUTHOR` values above are specific to this
  local-CLI-broadcast path and will need to change once a real DON is involved.
- `project.yaml` staging RPC points at `https://ethereum-sepolia-rpc.publicnode.com`
  (real Sepolia). Swap to a local anvil fork URL if rehearsing for free (see
  Appendix).
- **`Diverted` is the one status never seen live** — none across ~800 flights
  sampled at JFK and ORD. It shares the `Canceled` branch exactly, so the
  logic is exercised, but that specific enum value has not come back from the
  API in testing.
- **Only one real provider is wired.** The two-source mechanism and its
  disagreement handling are built and tested (see "Two independent sources"),
  but the second slot was tested with the mock gist standing in. A genuinely
  independent second provider still needs its own subscription — free,
  HTTPS-capable flight APIs with actual arrival times are scarce (AviationStack's
  free tier is HTTP-only, which CRE rejects; FlightLabs' free allowance is ~50
  requests; FlightAware is paid).
- **Rate limits are per-second on the free plan**, and a real DON multiplies
  every settlement by its node count. A production deployment would need a
  paid tier sized to the DON, or a caching layer in front of the provider.
- **Short-horizon crypto markets are impractical without deploy access.** A
  5-minute market wants settling seconds after expiry; every settlement is
  currently a hand-run command. Longer horizons are the usable ones until the
  workflow runs on a real DON.
- **FlightMarket does not inherit `ParimutuelMarket`.** The shared base was
  extracted from it, and `CryptoMarket` uses it, but the flight contract is
  already deployed with live positions and is wired into the frontend by its
  exact ABI — migrating it would mean a new address and orphaned markets for
  no functional gain. It should move onto the base whenever it is next
  redeployed. Until then the parimutuel logic exists in two places, and the
  `Settled` event differs between them (`int32` there, `int256` in the base),
  which the frontend has to decode separately.
- **Two dead crypto markets (ids 0 and 1)** exist from the first
  `CreateCryptoMarkets` run, whose stakes reverted with `TooLate`. They have
  empty pools and can only ever void.
