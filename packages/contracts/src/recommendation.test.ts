import { describe, it, expect } from "vitest";
import { StockRecommendation } from "./recommendation.js";

const base = {
  schema_version: 1,
  run_id: "7b1e2c4a-1b2c-4d5e-8f90-123456789abc",
  input_hash: "h",
  agent_version: "1.0.0",
  model: "m",
  abstain: true,
  ticker: "BTC/USD",
  direction: "flat",
  conviction: 0.2,
  thesis: "No edge.",
  horizon_days: 7,
  invalidation_condition: "Price reclaims MA20.",
  est_edge_bps: 0,
  est_vol: 0.5,
  bet_class: "core",
};
const withEvidence = (value: unknown) =>
  StockRecommendation.safeParse({ ...base, evidence: [{ claim: "c", source: "s", value }] });

describe("StockRecommendation evidence.value tolerance", () => {
  it("accepts numbers and strings unchanged", () => {
    expect(withEvidence(1.5).success).toBe(true);
    expect(withEvidence("x").success).toBe(true);
  });

  it("stringifies objects and arrays", () => {
    const r = withEvidence({ last: 1, ma20: 2 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.evidence[0]!.value).toBe('{"last":1,"ma20":2}');
    expect(withEvidence([1, 2]).success).toBe(true);
  });

  it("accepts null/undefined (an absent field) as 'unavailable' — the production failure", () => {
    for (const v of [null, undefined]) {
      const r = withEvidence(v);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.evidence[0]!.value).toBe("unavailable");
    }
  });

  it("accepts booleans as strings", () => {
    const r = withEvidence(true);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.evidence[0]!.value).toBe("true");
  });

  it("still rejects out-of-range conviction (bounds are NOT relaxed)", () => {
    expect(StockRecommendation.safeParse({ ...base, conviction: 1.7, evidence: [{ claim: "c", source: "s", value: 1 }] }).success).toBe(false);
  });

  it("still requires at least one evidence item", () => {
    expect(StockRecommendation.safeParse({ ...base, evidence: [] }).success).toBe(false);
  });
});
