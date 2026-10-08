# predictsafe-settlement

The CRE workflow behind every settlement in PredictSafe, and the keeper behind
the exchange's fills and the automatic settlement requests. One TypeScript file,
`main.ts`, compiled to WASM and run by a ten-node DON. Why it is built this way
is in the [root README](../../README.md); how to operate it is in
[RUNBOOK](../../RUNBOOK.md).

## Handlers

Trigger indices are positions in a list built at runtime — a handler is
registered only when its contract address (and schedule, for crons) is set, so
leaving one out shifts every later index down. With the production config:

| index | trigger | handler | does |
|---|---|---|---|
| 0 | log | `onSettlementRequested` | settles a flight from AeroDataBox |
| 1 | log | `onCryptoSettlementRequested` | settles crypto and AMM markets from Coinbase / Kraken / Bitstamp candles |
| 2 | log | `onStockSettlementRequested` | settles a stock market from a Chainlink Data Feed |
| 3 | log | `onReserveSettlementRequested` | settles a reserve market from a PoR / NAV feed |
| 4–6 | cron `sweepSchedule` | `onSweepFlights` / `onSweepCrypto` / `onSweepStocks` | re-settles anything left in SettlementRequested |
| 7 | cron `exchangeSchedule` | `onFillOrders` | fills AssetExchange orders that have a new price |
| 8 | cron `keeperSchedule` | `onRequestDue` | reports due markets to SettlementKeeper, which requests their settlement |

Every cron reads at the last finalized block, so all nodes see the same state.
Each execution may make at most 15 chain reads.

## Commands

From `cre/`:

```bash
(cd settlement && bun test)                                          # unit tests
cre workflow simulate ./settlement --target production-settings \
  --trigger-index 8 --non-interactive                                # real WASM, no write
cre workflow deploy ./settlement --target production-settings --yes  # replaces the live workflow
cre workflow get ./settlement --target production-settings           # which binary is live
cre execution list predictsafe-settlement --status FAILURE           # expect none
./preflight.sh production                                            # every receiver agrees
```

`simulate` without `--broadcast` is the fastest way to test anything: the real
runtime, Vault secrets resolved locally, answers in seconds. A log handler
needs `--evm-tx-hash` and `--evm-event-index` as well; RUNBOOK has examples.

## Config

`config.production.json` holds every contract address and schedule; the
AeroDataBox key is not in it — `apiKeySecretId` names a Vault DON secret.
`config.staging.json` is gitignored and belongs to the retired local path.
