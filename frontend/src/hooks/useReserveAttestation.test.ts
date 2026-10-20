import { describe, expect, it } from "vitest";
import { nextAttestation } from "./useReserveAttestation";

describe("next attestation", () => {
  const hour = Date.UTC(2026, 9, 20, 22) / 1000;

  it("is minute 45 of this hour while it is still ahead", () => {
    expect(nextAttestation(hour + 10 * 60)).toBe(hour + 45 * 60);
  });

  it("moves to the next hour once this hour's run has started", () => {
    expect(nextAttestation(hour + 45 * 60)).toBe(hour + 3600 + 45 * 60);
    expect(nextAttestation(hour + 50 * 60)).toBe(hour + 3600 + 45 * 60);
  });
});
