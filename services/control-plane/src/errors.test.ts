import { describe, it, expect } from "vitest";
import { isAuthFailure, authStatus } from "./errors.js";

describe("isAuthFailure", () => {
  it("is true for 401 and 403 (Anthropic SDK errors carry .status)", () => {
    expect(isAuthFailure(Object.assign(new Error("invalid x-api-key"), { status: 401 }))).toBe(true);
    expect(isAuthFailure(Object.assign(new Error("forbidden"), { status: 403 }))).toBe(true);
  });
  it("is false for rate limits, server errors, validation errors and non-errors", () => {
    for (const status of [400, 404, 429, 500, 529]) {
      expect(isAuthFailure(Object.assign(new Error("x"), { status }))).toBe(false);
    }
    expect(isAuthFailure(new Error("no status"))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
    expect(isAuthFailure("401")).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
  it("authStatus reports the code or 'unknown'", () => {
    expect(authStatus(Object.assign(new Error("x"), { status: 401 }))).toBe(401);
    expect(authStatus(new Error("x"))).toBe("unknown");
    expect(authStatus(null)).toBe("unknown");
  });
});
