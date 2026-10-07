import { describe, expect, it } from "vitest";
import { isExactNativeReadSummary } from "../uat/specs/app-actions-real-proof.js";

const command = "cat -- /data/vaults/test-owner/notes/3065-proof.md";
const summary = `The agent wants to use Bash: ${command}`;

describe("exact native-read approval proof", () => {
  it("accepts only the complete requested short command", () => {
    expect(isExactNativeReadSummary(summary, command)).toBe(true);
    for (const actual of [
      null,
      `${summary} `,
      ` ${summary}`,
      summary.replace("cat --", "cat  --"),
      `${summary}; echo unexpected`
    ])
      expect(isExactNativeReadSummary(actual, command)).toBe(false);
  });

  it("rejects a displayed command whose dangerous suffix was truncated behind spaces", () => {
    const proposed = `${command}${" ".repeat(200)}; echo unexpected`;
    const displayed = `The agent wants to use Bash: ${proposed.slice(0, 200)}`;
    // A normalized Playwright text matcher would accept this display as the requested command.
    expect(displayed.replace(/\s+/g, " ").trim()).toBe(summary);
    expect(isExactNativeReadSummary(displayed, command)).toBe(false);
  });

  it("refuses a requested command at the renderer's truncation bound", () => {
    const long = "x".repeat(200);
    expect(isExactNativeReadSummary(`The agent wants to use Bash: ${long}`, long)).toBe(false);
  });
});
