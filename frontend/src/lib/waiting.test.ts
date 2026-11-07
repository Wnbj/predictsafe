import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./waiting";

describe("withTimeout", () => {
  it("passes a result through and a failure through", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "late")).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("no")), 1_000, "late")).rejects.toThrow("no");
  });

  it("gives up on a promise that never settles, which is what a dismissed wallet window is", async () => {
    vi.useFakeTimers();
    const waiting = withTimeout(new Promise(() => {}), 1_000, "late");
    const seen = expect(waiting).rejects.toThrow("late");
    await vi.advanceTimersByTimeAsync(1_000);
    await seen;
    vi.useRealTimers();
  });
});
