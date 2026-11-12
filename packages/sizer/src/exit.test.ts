import { describe, it, expect } from "vitest";
import { evaluateExit } from "./exit.js";

const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const base = { entryPrice: 100, lastPrice: 100, now: NOW };

describe("evaluateExit", () => {
  it("holds when price is between stop and target and within hold time", () => {
    const d = evaluateExit({ ...base, lastPrice: 101, openedAt: new Date(+NOW - 2 * DAY), horizonDays: 7 });
    expect(d.exit).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("stops out when price falls below the default 8% stop", () => {
    const d = evaluateExit({ ...base, lastPrice: 91 });
    expect(d.exit).toBe(true);
    expect(d.reason).toBe("stop_loss");
  });

  it("clamps a tight stock-style intent stop (1.5%) up to the 5% crypto floor", () => {
    // intent stop at 98.5 would fire at 98; with the floor, 97 must NOT exit, 94 must.
    expect(evaluateExit({ ...base, lastPrice: 97, intentStopPrice: 98.5 }).exit).toBe(false);
    expect(evaluateExit({ ...base, lastPrice: 94, intentStopPrice: 98.5 }).reason).toBe("stop_loss");
  });

  it("clamps a very wide intent stop down to the 15% cap", () => {
    expect(evaluateExit({ ...base, lastPrice: 84, intentStopPrice: 50 }).reason).toBe("stop_loss");
    expect(evaluateExit({ ...base, lastPrice: 86, intentStopPrice: 50 }).exit).toBe(false);
  });

  it("takes profit at the default 20% target", () => {
    const d = evaluateExit({ ...base, lastPrice: 121 });
    expect(d.exit).toBe(true);
    expect(d.reason).toBe("take_profit");
  });

  it("uses the intent take-profit distance (clamped to [10%, 40%])", () => {
    expect(evaluateExit({ ...base, lastPrice: 113, intentTakeProfitPrice: 112 }).reason).toBe("take_profit");
    expect(evaluateExit({ ...base, lastPrice: 105, intentTakeProfitPrice: 103 }).exit).toBe(false); // floor 10%
  });

  it("time-exits after horizon + 1 grace day", () => {
    const opened = new Date(+NOW - 8.5 * DAY);
    expect(evaluateExit({ ...base, lastPrice: 101, openedAt: opened, horizonDays: 7 }).reason).toBe("time_exit");
    expect(evaluateExit({ ...base, lastPrice: 101, openedAt: new Date(+NOW - 7.5 * DAY), horizonDays: 7 }).exit).toBe(false);
  });

  it("falls back to a 14d hold limit when the horizon is unknown", () => {
    expect(evaluateExit({ ...base, lastPrice: 101, openedAt: new Date(+NOW - 15.5 * DAY) }).reason).toBe("time_exit");
    expect(evaluateExit({ ...base, lastPrice: 101, openedAt: new Date(+NOW - 10 * DAY) }).exit).toBe(false);
  });

  it("never time-exits when openedAt is unknown", () => {
    expect(evaluateExit({ ...base, lastPrice: 101, horizonDays: 1 }).exit).toBe(false);
  });

  it("stop-loss takes precedence over time-exit", () => {
    const d = evaluateExit({ ...base, lastPrice: 80, openedAt: new Date(+NOW - 30 * DAY), horizonDays: 7 });
    expect(d.reason).toBe("stop_loss");
  });

  it("does nothing on invalid prices", () => {
    expect(evaluateExit({ ...base, entryPrice: 0 }).exit).toBe(false);
    expect(evaluateExit({ ...base, lastPrice: NaN }).exit).toBe(false);
  });
});
