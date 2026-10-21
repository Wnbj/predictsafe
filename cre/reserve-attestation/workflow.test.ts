import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem'
import {
	BAND_100,
	BAND_150,
	BAND_200,
	BAND_300,
	BAND_400,
	BAND_500,
	BAND_BELOW,
	coverageBand,
	encodeAttestation,
	evidenceHash,
	initWorkflow,
	onCronTrigger,
	parseUsd6,
	valueOf,
} from './workflow'

/**
 * What leaves the enclave is a band, and the band must be right on both sides
 * of every threshold — that is the whole published claim. The balance is
 * parsed without floats, the obligations use the exchange's own conversion,
 * and the evidence hash cannot be recomputed without the key.
 */

describe('balance', () => {
	test('parses a dollar decimal to mUSDC units without floats', () => {
		expect(parseUsd6('500.00')).toBe(500_000_000n)
		expect(parseUsd6('0.1')).toBe(100_000n)
		expect(parseUsd6('12345')).toBe(12_345_000_000n)
		expect(parseUsd6('1.2345678')).toBe(1_234_567n)
	})

	test('refuses anything that is not a plain decimal', () => {
		expect(() => parseUsd6('-5')).toThrow()
		expect(() => parseUsd6('5e3')).toThrow()
		expect(() => parseUsd6('')).toThrow()
	})
})

describe('coverage band', () => {
	const obligations = 308_710_000n // 308.71 mUSDC, measured 2026-10-20

	test('falls on the right side of every threshold', () => {
		expect(coverageBand(308_709_999n, obligations)).toBe(BAND_BELOW)
		expect(coverageBand(308_710_000n, obligations)).toBe(BAND_100)
		expect(coverageBand(463_065_000n, obligations)).toBe(BAND_150) // exactly 150%
		expect(coverageBand(463_064_999n, obligations)).toBe(BAND_100)
		expect(coverageBand(617_420_000n, obligations)).toBe(BAND_200)
		expect(coverageBand(500_000_000n, obligations)).toBe(BAND_150) // the demo balance
		expect(coverageBand(926_129_999n, obligations)).toBe(BAND_200)
		expect(coverageBand(926_130_000n, obligations)).toBe(BAND_300) // exactly 300%
		expect(coverageBand(1_234_840_000n, obligations)).toBe(BAND_400)
		expect(coverageBand(1_543_549_999n, obligations)).toBe(BAND_400)
		expect(coverageBand(1_543_550_000n, obligations)).toBe(BAND_500) // exactly 500%
		expect(coverageBand(7_500_000_000n, obligations)).toBe(BAND_500) // and anything beyond
	})

	test('nothing outstanding is fully covered', () => {
		expect(coverageBand(0n, 0n)).toBe(BAND_500)
	})
})

describe('obligations', () => {
	test('values tokens at the feed price as the exchange does', () => {
		// 0.05 sXAU at $4,120.00 (8-decimal feed) = 206 mUSDC
		expect(valueOf(50_000_000_000_000_000n, 412_000_000_000n, 8)).toBe(206_000_000n)
		expect(valueOf(1n, 0n, 8)).toBe(0n)
	})
})

describe('report', () => {
	test('encodes exactly what ReserveAttestation decodes', () => {
		const evidence = keccak256(toHex('x'))
		const [band, obligations, asOf, hash] = decodeAbiParameters(
			parseAbiParameters('uint8, uint256, uint64, bytes32'),
			encodeAttestation(BAND_150, 308_710_000n, 1_792_522_800n, evidence),
		)
		expect([band, obligations, asOf, hash]).toEqual([BAND_150, 308_710_000n, 1_792_522_800n, evidence])
	})

	test('the evidence depends on the key, so it cannot be brute-forced without it', () => {
		const body = '{"balance":"500.00"}'
		expect(evidenceHash('key-a', body)).not.toBe(evidenceHash('key-b', body))
		expect(evidenceHash('key-a', body)).not.toBe(keccak256(toHex(body)))
	})
})

test('registers one handler, in a Nitro enclave', () => {
	const handlers = initWorkflow({
		schedule: '0 45 * * * *',
		custodianUrl: 'https://example.invalid/api/custodian',
		secretId: 'CUSTODIAN_API_KEY',
		chainSelectorName: 'ethereum-testnet-sepolia',
		exchangeAddress: '0x0000000000000000000000000000000000000001',
		attestationAddress: '0x0000000000000000000000000000000000000002',
		baseChainSelectorName: '',
		baseTokens: {},
		gasLimit: '500000',
	})
	expect(handlers).toHaveLength(1)
	expect(handlers[0]!.fn).toBe(onCronTrigger)
})
