import { describe, expect, it } from "vitest";
import { dismissToast, getToasts, showToast, txLabel } from "./toasts";

describe("txLabel", () => {
  it("names each panel's busy state for a notice", () => {
    expect(txLabel("staking")).toBe("Trade");
    expect(txLabel("withdrawing")).toBe("Liquidity withdrawal");
    expect(txLabel("fill-3")).toBe("Fill");
    expect(txLabel("cancel-0")).toBe("Take-back");
    expect(txLabel(null)).toBe("Transaction");
    expect(txLabel("something-new")).toBe("Transaction");
  });
});

describe("showToast", () => {
  it("replaces a notice by id rather than stacking a second", () => {
    // Exercised through the module's own store: a pending notice and its
    // confirmation share the transaction hash as id.
    showToast({ id: "0xa", state: "pending", title: "Trade sent" });
    showToast({ id: "0xa", state: "success", title: "Trade confirmed" });
    expect(getToasts().filter((t) => t.id === "0xa")).toEqual([
      { id: "0xa", state: "success", title: "Trade confirmed" },
    ]);
    dismissToast("0xa");
    expect(getToasts().some((t) => t.id === "0xa")).toBe(false);
  });

  it("keeps at most four on screen, dropping the oldest", () => {
    for (let i = 0; i < 6; i++) showToast({ id: `0x${i}`, state: "pending", title: `#${i}` });
    expect(getToasts().map((t) => t.id)).toEqual(["0x2", "0x3", "0x4", "0x5"]);
    for (let i = 0; i < 6; i++) dismissToast(`0x${i}`);
  });
});
