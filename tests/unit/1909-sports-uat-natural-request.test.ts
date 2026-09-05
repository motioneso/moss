import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Static regression guard for #2164/#2159: the 1909 UAT spec drives a real chat model
// through confirmThroughMoss. A prior version of that helper built its chat message by
// naming the internal dotted tool id, ordering "call it exactly once" / "do not call
// another tool", and dumping the raw JSON input — which a healthy model reads as an
// injected command and refuses, producing a test-only false negative (root cause recorded
// in docs/superpowers/handoffs/2026-09-01-2164-root-cause-relay.md's manifest continuation
// note). The fix rewrote every chat message as a plain-English user request. This guard
// fails the build the moment any of those forbidden patterns come back. Exact-substring
// checks are used (not a regex spanning template literals) because the file has many
// unrelated backtick-quoted strings that would make a scoped regex unreliable.
const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "../uat/specs/1909-sports-public-source-completion.uat.spec.ts");
const specSource = readFileSync(specPath, "utf8");

describe("1909 sports UAT spec sends natural chat requests (static)", () => {
  it("never orders the model to 'Call' a dotted sports tool id", () => {
    expect(specSource).not.toContain("Call sports.");
    expect(specSource).not.toContain("Call ${toolName}");
  });

  it("never orders the model not to call another tool", () => {
    expect(specSource).not.toContain("Do not call another tool");
  });

  it("never dumps the raw JSON tool input into the chat message", () => {
    expect(specSource).not.toContain("exactly once with this JSON input");
  });

  it("keeps confirmation ids and authorization acknowledgements in prose", () => {
    expect(specSource).toContain(
      "confirmation id ${confirmationId} and authorization acknowledgement"
    );
  });
});
