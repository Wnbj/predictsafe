import {
	blockNumber,
	bytesToHex,
	cre,
	encodeCallMsg,
	EVMClient,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	ok,
	prepareReportRequest,
	protoBigIntToBigint,
	text,
	TxStatus,
	type Runtime,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import {
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	keccak256,
	parseAbi,
	parseAbiParameters,
	toHex,
	zeroAddress,
} from 'viem'
import { z } from 'zod'

/**
 * Is the exchange backed off-chain? A CONFIDENTIAL workflow.
 *
 * Holding a synthetic gold or S&P 500 token is a claim on the exchange's
 * reserve. A real tokenized fund backs its tokens with assets at a custodian,
 * and the custodian tells only someone holding credentials what is in the
 * account. This workflow proves the backing to everyone WITHOUT telling anyone
 * the balance:
 *
 *  1. On the Workflow DON (public anyway): read what the tokens are worth —
 *     each asset's supply on Sepolia and Base Sepolia at its Chainlink feed
 *     price, at the finalized blocks.
 *  2. Inside the enclave: unseal the custodian's API key from the Vault DON,
 *     fetch the account, and compare the balance with what the tokens are
 *     worth. The key, the response and the balance never leave the enclave.
 *  3. Back on the DON: report only a coverage BAND — below 100%, ≥100%, ≥150%,
 *     ≥200%, ≥300%, ≥400%, ≥500% — to ReserveAttestation. An exact ratio would
 *     give the balance away, since the obligations it is measured against are
 *     on chain; past 500% the band says nothing more about how large it is.
 *
 * What is NOT confidential, and should be said: this code. The handler ships
 * in the binary the DON hands to the enclave; the enclave protects the data
 * the code computes over, not the code.
 */

export const configSchema = z.object({
	schedule: z.string(),
	/** The custodian's account endpoint. */
	custodianUrl: z.string(),
	/** Vault secret holding the custodian's bearer key. */
	secretId: z.string(),
	chainSelectorName: z.string(),
	exchangeAddress: z.string(),
	attestationAddress: z.string(),
	/** Base Sepolia, where tokens moved by CCIP live; empty to count Sepolia only. */
	baseChainSelectorName: z.string().default(''),
	/** The same tokens on Base Sepolia, by the exchange's feed symbol (XAU, CSPX). */
	baseTokens: z.record(z.string()).default({}),
	gasLimit: z.string().default('500000'),
})
export type Config = z.infer<typeof configSchema>

export const BAND_BELOW = 0
export const BAND_100 = 1
export const BAND_150 = 2
export const BAND_200 = 3
export const BAND_300 = 4
export const BAND_400 = 5
export const BAND_500 = 6

/** Lower bound of each band above BAND_BELOW, in basis points of the obligations. */
const BAND_FLOORS_BPS = [10_000n, 15_000n, 20_000n, 30_000n, 40_000n, 50_000n] as const

// --- pure: what decides the band, testable without a DON --------------------

/** A decimal string of dollars as mUSDC units (6 places), without floats. */
export const parseUsd6 = (s: string): bigint => {
	const m = /^\s*(\d+)(?:\.(\d{0,6})\d*)?\s*$/.exec(s)
	if (!m) throw new Error('Custodian balance is not a decimal')
	return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))
}

/** Which band a balance falls in against what the tokens are worth. */
export const coverageBand = (balance6: bigint, obligations6: bigint): number => {
	if (obligations6 === 0n) return BAND_500
	const bps = (balance6 * 10_000n) / obligations6
	let band = BAND_BELOW
	BAND_FLOORS_BPS.forEach((floor, i) => {
		if (bps >= floor) band = i + 1
	})
	return band
}

/** Tokens (18 decimals) at a feed price, in mUSDC — the exchange's own conversion. */
export const valueOf = (tokens: bigint, price: bigint, feedDecimals: number): bigint =>
	price > 0n ? (tokens * price) / 10n ** BigInt(18 + feedDecimals - 6) : 0n

/**
 * keccak256(apiKey ‖ response). Binding — anyone holding the key can recompute
 * it — but a plain hash of the response would let anyone brute-force a small
 * balance out of it.
 */
export const evidenceHash = (apiKey: string, body: string): `0x${string}` => keccak256(toHex(apiKey + body))

/** The report ReserveAttestation decodes. */
export const encodeAttestation = (
	band: number,
	obligations: bigint,
	balanceAsOf: bigint,
	evidence: `0x${string}`,
): `0x${string}` =>
	encodeAbiParameters(parseAbiParameters('uint8 band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash'), [
		band,
		obligations,
		balanceAsOf,
		evidence,
	])

const custodianSchema = z.object({ balance: z.string(), asOf: z.string(), currency: z.literal('USD') })

// --- chain reads, on the DON ------------------------------------------------------

const exchangeAbi = parseAbi([
	'function assetCount() view returns (uint256)',
	'function asset(uint32 assetId) view returns (string symbol, address feed, address token, uint8 feedDecimals, bool active)',
])
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)'])
const erc20Abi = parseAbi(['function totalSupply() view returns (uint256)'])

const clientFor = (selectorName: string): EVMClient => {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: selectorName })
	if (!network) throw new Error(`Unknown chain selector name: ${selectorName}`)
	return new EVMClient(network.chainSelector.selector)
}

const finalized = (runtime: Runtime<Config>, client: EVMClient): bigint => {
	const header = client.headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result()
	if (!header.header?.blockNumber) throw new Error('Could not resolve the finalized block')
	return protoBigIntToBigint(header.header.blockNumber)
}

const call = (runtime: Runtime<Config>, client: EVMClient, to: string, data: `0x${string}`, at: bigint) =>
	bytesToHex(
		client
			.callContract(runtime, {
				call: encodeCallMsg({ from: zeroAddress, to: to as `0x${string}`, data }),
				blockNumber: blockNumber(at),
			})
			.result().data ?? new Uint8Array(),
	)

/** What every outstanding token is worth, in mUSDC — public data, read on the DON. */
const readObligations = (runtime: Runtime<Config>): bigint => {
	const cfg = runtime.config
	const sepolia = clientFor(cfg.chainSelectorName)
	const at = finalized(runtime, sepolia)
	const base = cfg.baseChainSelectorName ? clientFor(cfg.baseChainSelectorName) : null
	const baseAt = base ? finalized(runtime, base) : 0n

	const count = decodeFunctionResult({
		abi: exchangeAbi,
		functionName: 'assetCount',
		data: call(runtime, sepolia, cfg.exchangeAddress, encodeFunctionData({ abi: exchangeAbi, functionName: 'assetCount' }), at),
	}) as bigint

	let total = 0n
	for (let i = 0; i < Number(count); i++) {
		const [symbol, feed, token, feedDecimals] = decodeFunctionResult({
			abi: exchangeAbi,
			functionName: 'asset',
			data: call(runtime, sepolia, cfg.exchangeAddress, encodeFunctionData({ abi: exchangeAbi, functionName: 'asset', args: [i] }), at),
		}) as readonly [string, `0x${string}`, `0x${string}`, number, boolean]
		const [, price] = decodeFunctionResult({
			abi: feedAbi,
			functionName: 'latestRoundData',
			data: call(runtime, sepolia, feed, encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' }), at),
		}) as readonly [bigint, bigint, bigint, bigint, bigint]
		let supply = decodeFunctionResult({
			abi: erc20Abi,
			functionName: 'totalSupply',
			data: call(runtime, sepolia, token, encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }), at),
		}) as bigint
		const remote = cfg.baseTokens[symbol]
		if (base && remote) {
			supply += decodeFunctionResult({
				abi: erc20Abi,
				functionName: 'totalSupply',
				data: call(runtime, base, remote, encodeFunctionData({ abi: erc20Abi, functionName: 'totalSupply' }), baseAt),
			}) as bigint
		}
		total += valueOf(supply, price, Number(feedDecimals))
	}
	return total
}

// --- the handler: starts in the enclave ------------------------------------------

export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const cfg = runtime.config
	const don = runtime.usingTheDons()

	// 1. Public: what the tokens are worth. Chain reads always run on the DON.
	const obligations = readObligations(don)

	// 2. Confidential: the key, the account, the comparison — inside the enclave.
	const apiKey = runtime.getSecret({ id: cfg.secretId }).result().value
	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: cfg.custodianUrl,
			method: 'GET',
			multiHeaders: { Authorization: { values: [`Bearer ${apiKey}`] } },
		})
		.result()
	if (!ok(response)) throw new Error(`Custodian answered HTTP ${response.statusCode}`)

	const body = text(response)
	const account = custodianSchema.parse(JSON.parse(body))
	const band = coverageBand(parseUsd6(account.balance), obligations)
	const balanceAsOf = BigInt(Math.floor(Date.parse(account.asOf) / 1000))
	const evidence = evidenceHash(apiKey, body)
	// No log here: anything logged leaves the enclave. The band is reported
	// on chain anyway; the balance must not appear anywhere.

	// 3. Only the conclusion crosses back: band, the public obligations, the
	//    custodian's timestamp, and a keyed hash of what was read.
	const report = don.report(prepareReportRequest(encodeAttestation(band, obligations, balanceAsOf, evidence))).result()
	const tx = clientFor(cfg.chainSelectorName)
		.writeReport(don, {
			receiver: cfg.attestationAddress,
			report,
			gasConfig: { gasLimit: cfg.gasLimit },
		})
		.result()
	if (tx.txStatus !== TxStatus.SUCCESS) throw new Error(`Attestation write failed: ${tx.errorMessage || tx.txStatus}`)
	return `band ${band} against ${obligations} mUSDC of tokens, tx ${bytesToHex(tx.txHash ?? new Uint8Array(32))}`
}

export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	return [
		// AWS Nitro in us-west-2: the only registered TEE type and region today.
		cre.handlerInTee(cron.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
