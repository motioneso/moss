import { describe, expect, it } from "vitest";

import { toErrFrame } from "../../packages/cli-runner/src/connection.js";

describe("cli-runner RPC error frames", () => {
  it("preserves only a bounded numeric status code", () => {
    const cause = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const error = Object.assign(new Error("redacted upstream failure"), {
      statusCode: 429,
      cause
    });

    const frame = toErrFrame(1, "boot-1", error);

    expect(frame.error).toEqual({
      code: "internal",
      message: "redacted upstream failure",
      statusCode: 429
    });
    expect(JSON.stringify(frame)).not.toContain("rate limited");
    expect(JSON.stringify(frame)).not.toContain("cause");
  });

  it("omits invalid status values", () => {
    const frame = toErrFrame(
      1,
      "boot-1",
      Object.assign(new Error("failure"), { statusCode: "429" })
    );

    expect(frame.error).toEqual({ code: "internal", message: "failure" });
  });
});
