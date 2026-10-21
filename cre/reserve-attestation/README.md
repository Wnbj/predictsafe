# reserve-attestation — a confidential workflow

Is the exchange backed off-chain? This workflow answers it without telling
anyone the balance. It runs its handler inside a TEE (`handlerInTee`, AWS Nitro
in us-west-2), scaffolded from Chainlink's `hello-confidential-workflows-ts`
template with `cre init`.

| step | where | what | confidential? |
|---|---|---|---|
| 1 | Workflow DON | what the exchange's tokens are worth: each asset's supply on Sepolia and Base Sepolia at its Chainlink feed price, finalized blocks | no — public anyway |
| 2 | enclave | unseal `CUSTODIAN_API_KEY` from the Vault DON, fetch the custodian's account, compare the balance with step 1 | **yes** |
| 3 | Workflow DON | report a coverage band to `ReserveAttestation` | only the band leaves |

**Why a band, not a percentage.** The obligations are public, so an exact
coverage ratio would give the balance away. The report says only below 100%,
≥100%, ≥150%, ≥200%, ≥300%, ≥400% or ≥500%, plus `keccak256(apiKey ‖ response)`
as evidence an auditor holding the key can recompute and no one else can
brute-force. Past 500% it says nothing more about how large the balance is.

**What is NOT confidential:** this code. The binary is handed to the enclave by
the DON; the enclave protects the data the code computes over. And anything
logged inside the handler leaves the enclave — which is why it logs nothing.

The custodian is a demo: `frontend/api/custodian.ts`, a Vercel function that
answers only with `Authorization: Bearer $CUSTODIAN_API_KEY` and reports
`CUSTODIAN_BALANCE` with `asOf` fixed to the start of the hour, so every
enclave and retry in the hour reads the same bytes.

```bash
bun install
bun test
# from cre/: a local custodian on :8787, then the simulator (no beta needed)
cre workflow simulate ./reserve-attestation --target staging-settings --non-interactive --trigger-index 0
```

Receiver: `ReserveAttestation` `0x9e7F6886B01eA9b0E5E9AF8CFF3fc25596718ED0`
(Sepolia, seven bands, since 2026-10-21), expecting workflow
`predictsafe-reserve`; the first receiver, `0xC1C2…5DdB`, stopped at ≥200% and
keeps its fifteen attestations. Reports carry a 1.2M gas limit — the first real
one ran out at 700k (RUNBOOK, "Off-chain backing"). Live on the DON since
2026-10-20, hourly at :45; `cre/health.sh` shows when it last landed.
