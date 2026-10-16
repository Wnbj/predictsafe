import { describe, expect, it } from "vitest";
import { decodeAbiParameters, zeroAddress } from "viem";
import { bridgeMessage, CCIP_CHAINS, ccipSendCall, tokenOn } from "./ccip";

/**
 * The message the router is asked to carry. What matters: the receiver is the
 * ABI-encoded address CCIP expects for an EVM destination, the fee is paid in
 * native gas (fee token zero) and travels as the call's value, and each
 * direction names the OTHER chain's selector.
 */

const ME = "0x00000000000000000000000000000000000a11ce" as const;
const TOKEN = "0x502640827C31ce347FBe42a5bD6e08Dc98C4a9E0" as const;

describe("bridgeMessage", () => {
  it("encodes the receiver as a 32-byte address and pays in native gas", () => {
    const m = bridgeMessage(ME, TOKEN, 5n);
    expect(decodeAbiParameters([{ type: "address" }], m.receiver)[0].toLowerCase()).toBe(ME);
    expect(m.feeToken).toBe(zeroAddress);
    expect(m.tokenAmounts).toEqual([{ token: TOKEN, amount: 5n }]);
    expect(m.data).toBe("0x");
  });
});

describe("ccipSendCall", () => {
  it("sends from Sepolia's router to Base Sepolia's selector, with the fee as value", () => {
    const c = ccipSendCall("sepolia", ME, TOKEN, 5n, 123n);
    expect(c.address).toBe(CCIP_CHAINS.sepolia.router);
    expect(c.args[0]).toBe(CCIP_CHAINS.base.selector);
    expect(c.value).toBe(123n);
  });

  it("sends back the other way from Base's router", () => {
    const c = ccipSendCall("base", ME, TOKEN, 5n, 1n);
    expect(c.address).toBe(CCIP_CHAINS.base.router);
    expect(c.args[0]).toBe(CCIP_CHAINS.sepolia.selector);
  });
});

describe("tokenOn", () => {
  it("finds the exchange's tokens on Sepolia by symbol", () => {
    expect(tokenOn("sepolia", "sXAU")).toBe(TOKEN);
    expect(tokenOn("sepolia", "nope")).toBeNull();
  });
});
