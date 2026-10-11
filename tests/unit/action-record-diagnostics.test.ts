import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportActionRecordFailure } from "../../packages/ai/src/gateway/action-record-diagnostics.js";

afterEach(() => vi.restoreAllMocks());

function report(id: string, error: unknown) {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  reportActionRecordFailure(id, error);
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0]?.[0]).toBe("action_record_delivery_failed");
  return warning.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe("action record diagnostics", () => {
  it.each([Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError])(
    "uses a fixed class for %s rather than its mutable name or message",
    (ErrorClass) => {
      const error = new ErrorClass("PRIVATE SQL with private values");
      error.name = "PRIVATE forged error name";
      Object.assign(error, { code: "23514", cause: new Error("PRIVATE cause") });
      expect(report(`native-${ErrorClass.name}`, error)).toEqual({
        actionRequestId: `native-${ErrorClass.name}`,
        errorClass: ErrorClass.name
      });
    }
  );

  it.each(["23514", "42501", "40P01"])("retains genuine PostgreSQL SQLSTATE %s only", (code) => {
    const error = new pg.DatabaseError("PRIVATE SQL and values", 1, "error");
    Object.defineProperty(error, "name", { value: "PRIVATE database name" });
    error.code = code;
    error.detail = "PRIVATE row contents";
    expect(report(`postgres-${code}`, error)).toEqual({
      actionRequestId: `postgres-${code}`,
      errorClass: "PostgresError",
      postgresCode: code
    });
  });

  it.each(["23514\n", "23514 SQL", "1234", "123456", "abcde", "ab\ncd"])(
    "omits malformed PostgreSQL code %j",
    (code) => {
      const error = new pg.DatabaseError("PRIVATE SQL", 1, "error");
      error.code = code;
      expect(report(`malformed-${JSON.stringify(code)}`, error)).toEqual({
        actionRequestId: `malformed-${JSON.stringify(code)}`,
        errorClass: "PostgresError"
      });
    }
  );

  it("does not inspect hostile proxies or invoke error field getters", () => {
    const trap = vi.fn(() => {
      throw new Error("PRIVATE getter contents");
    });
    const proxy = new Proxy(
      {},
      { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }
    );
    expect(report("hostile-proxy", proxy)).toEqual({
      actionRequestId: "hostile-proxy",
      errorClass: "Unknown"
    });
    vi.restoreAllMocks();
    const error = new pg.DatabaseError("PRIVATE SQL", 1, "error");
    for (const field of ["name", "message", "code", "cause", "constructor"])
      Object.defineProperty(error, field, { get: trap });
    expect(report("hostile-getters", error)).toEqual({
      actionRequestId: "hostile-getters",
      errorClass: "PostgresError"
    });
    expect(trap).not.toHaveBeenCalled();
  });

  it("does not invoke native error name getters or report custom subclass names", () => {
    const getName = vi.fn(() => {
      throw new Error("PRIVATE name getter");
    });
    class PrivateSubsystemError extends Error {}
    const error = new PrivateSubsystemError("PRIVATE message");
    Object.defineProperty(error, "name", { get: getName });
    expect(report("native-name-getter", error)).toEqual({
      actionRequestId: "native-name-getter",
      errorClass: "Error"
    });
    expect(getName).not.toHaveBeenCalled();
  });

  it("does not treat forged database-shaped objects as database errors", () => {
    expect(
      report("fake-database", { name: "DatabaseError", code: "23514", message: "PRIVATE" })
    ).toEqual({
      actionRequestId: "fake-database",
      errorClass: "Unknown"
    });
  });

  it("deduplicates retries even when a later layer reports another error", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportActionRecordFailure("same-record", new TypeError("PRIVATE first"));
    reportActionRecordFailure("same-record", new Error("PRIVATE second"));
    expect(warning).toHaveBeenCalledExactlyOnceWith("action_record_delivery_failed", {
      actionRequestId: "same-record",
      errorClass: "TypeError"
    });
  });
});
