import { describe, expect, it } from "vitest";
import { failedAssertionLines } from "../../scripts/test-meeting-link-revocation-controls.js";

const failure = (
  fullName: string,
  message = "AssertionError: explicit-browser-start: expected 409 to be 200"
) => ({
  fullName,
  status: "failed",
  failureMessages: [message]
});

describe("meeting revocation proof diagnostics", () => {
  it("includes the failed test name and first assertion line without stack or report contents", () => {
    expect(
      failedAssertionLines([
        { fullName: "passed test", status: "passed", failureMessages: [] },
        failure(
          "recording-only revocation",
          "\nAssertionError: explicit-browser-start: expected 409 to be 200\n    at private fixture detail"
        ),
        failure("unlink revocation")
      ])
    ).toEqual([
      "recording-only revocation: AssertionError: explicit-browser-start: expected 409 to be 200",
      "unlink revocation: AssertionError: explicit-browser-start: expected 409 to be 200"
    ]);
  });

  it("bounds test count, name and assertion length", () => {
    const lines = failedAssertionLines(
      Array.from({ length: 10 }, () => failure("n".repeat(400), "e".repeat(900)))
    );
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length === 702)).toBe(true);
  });

  it("strips terminal escapes, collapses name newlines and handles missing assertion messages", () => {
    expect(
      failedAssertionLines([
        failure(
          "\u001b[31mrecording\nonly\u001b[0m",
          "\u001b[31mAssertionError: mismatch\u001b[0m\nprivate stack"
        ),
        { fullName: "missing", status: "failed", failureMessages: [] }
      ])
    ).toEqual(["recording only: AssertionError: mismatch", "missing: No assertion message"]);
    expect(failedAssertionLines([])).toEqual([]);
  });
});
