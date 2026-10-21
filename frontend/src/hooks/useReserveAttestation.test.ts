import { describe, expect, it } from "vitest";
import { hourCells, nextAttestation } from "./useReserveAttestation";

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

describe("hour cells", () => {
  const H = Date.UTC(2026, 9, 21, 15) / 1000; // 15:00 UTC
  const now = H + 20 * 60; // 15:20, this hour's run still ahead

  it("marks attested hours, a missed one inside the history, and the hour still to come", () => {
    const history = [
      { band: 3, balanceAsOf: H - 3 * 3600 },
      { band: 3, balanceAsOf: H - 2 * 3600 },
      // H - 3600 (14:00) missed
    ];
    const cells = hourCells(history, now, 5);
    expect(cells.map((c) => c.state)).toEqual(["before", "attested", "attested", "missed", "pending"]);
    expect(cells[1]).toMatchObject({ hour: H - 3 * 3600, band: 3 });
  });

  it("an hour whose run has passed is not pending any more", () => {
    const cells = hourCells([{ band: 6, balanceAsOf: H }], H + 50 * 60, 1);
    expect(cells[0]).toMatchObject({ state: "attested", band: 6 });
    expect(hourCells([{ band: 6, balanceAsOf: H - 3600 }], H + 50 * 60, 1)[0]!.state).toBe("missed");
  });
});
