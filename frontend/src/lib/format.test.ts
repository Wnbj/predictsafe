import { describe, expect, it } from "vitest";
import { formatClock, formatTimestamp, localTimes } from "./format";

/**
 * Times are shown in Bulgarian time whatever the browser's zone — the chain
 * and the questions on it speak UTC. Both sides of the October clock change
 * (last Sunday, 2026-10-25 01:00 UTC) are covered, since that is where a fixed
 * "+3" would go wrong.
 */
describe("Bulgarian time", () => {
  const OCT_20 = Date.UTC(2026, 9, 20, 12) / 1000;

  it("moves a question's UTC moment into Sofia time, summer offset", () => {
    expect(localTimes("Will BTC be at or above $83,000 at 22:18 UTC on Oct 13?", OCT_20)).toBe(
      "Will BTC be at or above $83,000 at 01:18 EEST on Oct 14?",
    );
  });

  it("uses the winter offset after the clocks go back", () => {
    expect(localTimes("Will XAU be at or above $4,100 at 20:00 UTC on Oct 26?", OCT_20)).toBe(
      "Will XAU be at or above $4,100 at 22:00 EET on Oct 26?",
    );
  });

  it("takes the nearest year across New Year", () => {
    const DEC_31 = Date.UTC(2026, 11, 31, 20) / 1000;
    expect(localTimes("at 23:30 UTC on Jan 1", DEC_31)).toBe("at 01:30 EET on Jan 2");
  });

  it("leaves text without a UTC moment alone", () => {
    expect(localTimes("Will BA286 on Oct 21 arrive 30m+ late?", OCT_20)).toBe(
      "Will BA286 on Oct 21 arrive 30m+ late?",
    );
  });

  it("formats timestamps and clock times in Sofia, not the browser's zone", () => {
    const t = Date.UTC(2026, 9, 20, 21, 45) / 1000;
    expect(formatClock(t)).toBe("00:45 EEST");
    expect(formatTimestamp(t)).toContain("00:45");
    expect(formatTimestamp(t)).toContain("21");
  });
});
