import { describe, expect, it } from "vitest";
import { cryptoMarketTerms, HORIZONS, roundStrike } from "./createMarket";

/**
 * What the "Create market" form sends. The contract checks only that the
 * strike is non-zero and that staking closes no later than expiry, so the
 * rest — a fair close, a whole-minute expiry, a question that says what the
 * market actually measures — is this module's job.
 */

// 2026-10-13 21:17:43 UTC
const NOW = Date.UTC(2026, 9, 13, 21, 17, 43) / 1000;
const hour = HORIZONS.find((h) => h.label === "1 hour")!;

describe("cryptoMarketTerms", () => {
  it("expires on a whole minute and names it in UTC", () => {
    const t = cryptoMarketTerms("BTC", 83_000, hour, NOW);
    expect(t.expiryTime % 60).toBe(0);
    expect(t.expiryTime).toBe(Date.UTC(2026, 9, 13, 22, 18, 0) / 1000);
    expect(t.question).toBe("Will BTC be at or above $83,000 at 22:18 UTC on Oct 13?");
  });

  it("closes staking before expiry, never at or after it", () => {
    for (const h of HORIZONS) {
      const t = cryptoMarketTerms("ETH", 2_500, h, NOW);
      expect(t.closeTime).toBeLessThan(t.expiryTime);
      expect(t.closeTime).toBeGreaterThan(NOW);
    }
  });

  it("carries the strike at 8 decimals, cents included", () => {
    expect(cryptoMarketTerms("BTC", 83_000, hour, NOW).strike).toBe(8_300_000_000_000n);
    expect(cryptoMarketTerms("ETH", 2_512.5, hour, NOW).strike).toBe(251_250_000_000n);
  });
});

describe("roundStrike", () => {
  it("snaps to a number a person would type", () => {
    expect(roundStrike("BTC", 83_333.78)).toBe(83_300);
    expect(roundStrike("ETH", 2_514.9)).toBe(2_510);
  });
});
