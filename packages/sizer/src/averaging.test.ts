import { describe, it, expect } from "vitest";
import { managePosition, DEFAULT_MANAGE_CONFIG } from "./averaging.js";
import type { ManageInput } from "./averaging.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(+NOW - d * DAY);

// A position bought at 100 (10 units = $1,000 cost) on a $100k account; price has fallen to 92.
const base: ManageInput = {
  entryPrice: 100,
  lastPrice: 92,
  qty: 10,
  navUsd: 100_000,
  haltLevel: 0,
  drawdownFraction: 0.01,
  dailyPnlUsd: 0,
  adds: 0,
  openedAt: daysAgo(5),
  horizonDays: 7,
  prevClose: 92.5,
  volumeZ: 0.5,
  recentCloses: [100, 97, 95, 93, 90, 91, 92], // low 90, price has bounced >1% off it
  now: NOW,
};
const run = (o: Partial<ManageInput> = {}) => managePosition({ ...base, ...o });

describe("managePosition — cost averaging only when it makes sense", () => {
  it("adds one tranche (1% NAV) when discounted, stabilised, and within reach", () => {
    const r = run();
    expect(r.action).toBe("add");
    expect(r.reason).toBe("averaging_add");
    expect(r.notionalUsd).toBeCloseTo(1000, 6);
    expect(r.newAvgEntry!).toBeLessThan(100);
    expect(r.newAvgEntry!).toBeGreaterThan(92);
    expect(r.blockers).toEqual([]);
  });

  it("does NOT buy just because price is lower: no discount yet -> hold", () => {
    const r = run({ lastPrice: 96, prevClose: 96.5, recentCloses: [100, 99, 98, 97, 95, 95.5, 96] });
    expect(r.action).toBe("hold");
    expect(r.detail).toContain("add needs price <=");
  });

  it("refuses a falling knife: down >3% today", () => {
    const r = run({ prevClose: 97 });
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("accelerating");
  });

  it("refuses a high-volume down day (distribution, not a bottom)", () => {
    const r = run({ volumeZ: 5 });
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("high-volume down day");
  });

  it("a volume spike on an UP day does not block", () => {
    expect(run({ volumeZ: 5, prevClose: 91 }).action).toBe("add");
  });

  it("refuses while the price is still making new lows", () => {
    const r = run({ recentCloses: [100, 97, 95, 94, 93, 92.5, 92] }); // today's close is the lowest
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("new lows");
  });

  it("refuses with too little price history", () => {
    const r = run({ recentCloses: [92, 91] });
    expect(r.blockers.join(" ")).toContain("insufficient history");
  });

  it("refuses when even the averaged break-even is out of reach", () => {
    // A $4,000 position down 15%: a $1,000 add only lowers the average to ~96.6, still +13.6% above price.
    const r = run({ qty: 40, entryPrice: 100, lastPrice: 85, prevClose: 85.2, recentCloses: [100, 95, 90, 82, 83, 84, 85] });
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("out of reach");
  });

  it("respects the 5% NAV position cap", () => {
    const r = run({ qty: 55, entryPrice: 100 }); // $5,500 cost already > 5% of $100k
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("position cost cap");
  });

  it("respects circuit breaker, portfolio drawdown and daily loss limit", () => {
    expect(run({ haltLevel: 2 }).blockers.join(" ")).toContain("circuit breaker");
    expect(run({ drawdownFraction: 0.12 }).blockers.join(" ")).toContain("drawdown");
    expect(run({ dailyPnlUsd: -2500 }).blockers.join(" ")).toContain("daily loss");
  });

  it("stops adding after maxAdds", () => {
    const r = run({ adds: 2, lastAddPrice: 99 });
    expect(r.action).toBe("hold");
    expect(r.blockers.join(" ")).toContain("ladder exhausted");
  });

  it("spaces adds: the next add needs a further 7% below the LAST add", () => {
    expect(run({ adds: 1, lastAddPrice: 92, lastPrice: 90, prevClose: 90.5, recentCloses: [97, 95, 93, 88, 89, 89.5, 90] }).action).toBe("hold");
    const r = run({ adds: 1, lastAddPrice: 92, lastPrice: 85, prevClose: 85.5, recentCloses: [95, 92, 90, 82, 83, 84, 85] });
    expect(r.action).toBe("add");
    expect(r.detail).toContain("add #2/2");
  });

  it("collects every blocker, not just the first", () => {
    const r = run({ prevClose: 99, volumeZ: 6, recentCloses: [100, 97, 95, 93, 92.5, 92.2, 92] });
    expect(r.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("managePosition — exits target the LOWERED average cost", () => {
  // After one add the average cost is 95; price has recovered to 95.6 — BELOW the original 100 entry.
  const averaged = { entryPrice: 95, qty: 20, adds: 1, lastAddPrice: 92, lastAddAt: daysAgo(3) };

  it("recovery: sells below the original entry for a profit once above the lowered average", () => {
    const r = run({ ...averaged, lastPrice: 95.6 });
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("recovery");
  });

  it("holds just under the lowered break-even while the recovery is fresh", () => {
    expect(run({ ...averaged, lastPrice: 94.5 }).action).toBe("hold");
  });

  it("no early 'recovery' exit for a position that was never averaged", () => {
    expect(run({ entryPrice: 90, lastPrice: 90.6, adds: 0, qty: 10 }).action).not.toBe("exit");
  });

  it("loss_reduction: a stalled recovery is closed at a reduced loss", () => {
    const r = run({ ...averaged, lastPrice: 93.5, lastAddAt: daysAgo(11) });
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("loss_reduction");
  });

  it("does not cut the loss early while the recovery is still young", () => {
    expect(run({ ...averaged, lastPrice: 93.5, lastAddAt: daysAgo(4) }).action).toBe("hold");
  });

  it("does not cut the loss if price is still too far below the lowered average", () => {
    expect(run({ ...averaged, lastPrice: 85, lastAddAt: daysAgo(11), prevClose: 85.1, recentCloses: [95, 92, 90, 84, 84.5, 84.8, 85] }).reason).not.toBe("loss_reduction");
  });

  it("take_profit still applies (default +20%)", () => {
    const r = run({ lastPrice: 121 });
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("take_profit");
  });
});

describe("managePosition — hard stops and time limits", () => {
  it("stops out when the unrealised loss reaches 3% of NAV", () => {
    const r = run({ qty: 40, entryPrice: 100, lastPrice: 92, navUsd: 10_000, prevClose: 92.2 });
    // loss = $320 >= 3% of $10k = $300
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("stop_loss");
  });

  it("a small position that cannot be averaged still has a price stop (the reviewed gap)", () => {
    // 2% of NAV position, filters block adds (price falling hard), down 30% -> must exit, not sit for 45 days.
    const r = run({ qty: 20, entryPrice: 100, lastPrice: 70, prevClose: 70.5, volumeZ: 6, recentCloses: [100, 95, 90, 80, 71, 70.5, 70] });
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("stop_loss");
  });

  it("the price stop sits 20% below the reference, so averaging rungs (-7%/-14%) get room first", () => {
    expect(run({ lastPrice: 80.5, prevClose: 80.6, recentCloses: [100, 95, 90, 82, 80.8, 80.6, 80.5], volumeZ: 6 }).action).toBe("hold"); // -19.5%
    expect(run({ lastPrice: 79.9, prevClose: 80, recentCloses: [100, 95, 90, 82, 80.8, 80.6, 79.9], volumeZ: 6 }).reason).toBe("stop_loss"); // -20.1%
  });

  it("after an add, the price stop is measured below the LAST ADD", () => {
    const a = { adds: 1, entryPrice: 95, qty: 20, lastAddPrice: 90, lastAddAt: daysAgo(2), prevClose: 73, recentCloses: [95, 92, 90, 74, 73, 72.5, 72.4] };
    expect(run({ ...a, lastPrice: 72.5 }).action).not.toBe("exit"); // -19.4% vs last add 90
    expect(run({ ...a, lastPrice: 71.9 }).reason).toBe("stop_loss"); // -20.1% vs last add 90
  });

  it("once the ladder is used up, stops 10% below the last add", () => {
    const r = run({ adds: 2, lastAddPrice: 80, lastPrice: 71, entryPrice: 85, qty: 30, prevClose: 71.2, recentCloses: [90, 85, 80, 70, 70.5, 70.8, 71] });
    expect(r.action).toBe("exit");
    expect(r.reason).toBe("stop_loss");
  });

  it("does NOT apply the old tight 5-15% stop to a position that can still be averaged", () => {
    const r = run({ lastPrice: 88, prevClose: 88.3, recentCloses: [100, 97, 92, 86, 87, 87.5, 88] }); // -12% vs avg
    expect(r.action).not.toBe("exit");
  });

  it("a LOSING position gets the long 45-day leash; a winning one follows the thesis horizon", () => {
    expect(run({ openedAt: daysAgo(20), lastPrice: 96, prevClose: 96.2, recentCloses: [100, 99, 98, 97, 95, 95.5, 96] }).action).not.toBe("exit");
    expect(run({ openedAt: daysAgo(46), lastPrice: 96, prevClose: 96.2, recentCloses: [100, 99, 98, 97, 95, 95.5, 96] }).reason).toBe("time_exit");
    expect(run({ openedAt: daysAgo(9), lastPrice: 101, horizonDays: 7 }).reason).toBe("time_exit");
  });

  it("is a no-op on invalid inputs", () => {
    expect(run({ entryPrice: 0 }).action).toBe("hold");
    expect(run({ lastPrice: NaN }).action).toBe("hold");
    expect(run({ qty: 0 }).action).toBe("hold");
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_MANAGE_CONFIG.maxAdds).toBe(2);
    expect(DEFAULT_MANAGE_CONFIG.maxPositionNavFraction).toBe(0.05);
  });
});
