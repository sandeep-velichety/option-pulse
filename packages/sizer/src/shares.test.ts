import { describe, it, expect } from "vitest";
import { wholeShares } from "./shares.js";

describe("wholeShares", () => {
  it("rounds down to whole shares — the production failures (13.97 AAPL, 31.7 NVDA)", () => {
    expect(wholeShares(4922.97, 352.45).qty).toBe(13);
    expect(wholeShares(4930.63, 155.46).qty).toBe(31);
  });
  it("never exceeds the requested notional", () => {
    for (const [n, p] of [[4922.97, 352.45], [4930.63, 155.46], [1000, 333.33], [99.99, 10]] as const) {
      const r = wholeShares(n, p);
      expect(r.notionalUsd).toBeLessThanOrEqual(n + 1e-9);
      expect(Number.isInteger(r.qty)).toBe(true);
    }
  });
  it("returns the exact traded notional", () => {
    expect(wholeShares(4922.97, 352.45).notionalUsd).toBeCloseTo(13 * 352.45, 6);
  });
  it("does not lose a share to float error on an exact multiple", () => {
    expect(wholeShares(0.3, 0.1).qty).toBe(3); // 0.3/0.1 = 2.9999999999999996
    expect(wholeShares(1000, 100).qty).toBe(10);
  });
  it("returns 0 when the notional cannot buy one share", () => {
    expect(wholeShares(300, 352.45).qty).toBe(0);
  });
  it("returns 0 on invalid input", () => {
    for (const [n, p] of [[0, 10], [-5, 10], [10, 0], [10, -1], [NaN, 10], [10, Infinity]] as const) {
      expect(wholeShares(n, p)).toEqual({ qty: 0, notionalUsd: 0 });
    }
  });
});

describe("wholeShares — minimum one share", () => {
  it("buys one share when the sized amount is too small but one share fits the hard cap", () => {
    const r = wholeShares(300, 352.45, 4900);
    expect(r.qty).toBe(1);
    expect(r.notionalUsd).toBeCloseTo(352.45, 6);
  });
  it("still rejects (qty 0) when even one share exceeds the hard cap", () => {
    expect(wholeShares(300, 6000, 4900).qty).toBe(0);
  });
  it("does not change the normal case or round up when it can already buy shares", () => {
    expect(wholeShares(4922.97, 352.45, 4900).qty).toBe(13);
  });
  it("the minimum rule is off when no cap is given", () => {
    expect(wholeShares(300, 352.45).qty).toBe(0);
  });
});

