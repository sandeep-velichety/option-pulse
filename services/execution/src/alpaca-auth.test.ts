import { describe, it, expect } from "vitest";
import { isAlpacaAuthError } from "./alpaca-auth.js";

const named = (name: string, status?: number) => Object.assign(new Error("x"), { name, ...(status ? { status } : {}) });

describe("isAlpacaAuthError", () => {
  it("recognises the SDK's AuthError (401) and PermissionError (403)", () => {
    expect(isAlpacaAuthError(named("AuthError", 401))).toBe(true);
    expect(isAlpacaAuthError(named("PermissionError", 403))).toBe(true);
  });
  it("recognises a bare status 401/403", () => {
    expect(isAlpacaAuthError(Object.assign(new Error("x"), { status: 401 }))).toBe(true);
    expect(isAlpacaAuthError(Object.assign(new Error("x"), { status: 403 }))).toBe(true);
  });
  it("ignores other failures: not found, validation, rate limit, server, network, non-errors", () => {
    for (const [n, s] of [["NotFoundError", 404], ["ValidationError", 422], ["RateLimitError", 429], ["ApiError", 500]] as const) {
      expect(isAlpacaAuthError(named(n, s))).toBe(false);
    }
    expect(isAlpacaAuthError(new Error("fetch failed"))).toBe(false);
    expect(isAlpacaAuthError(null)).toBe(false);
    expect(isAlpacaAuthError("AuthError")).toBe(false);
  });
});
