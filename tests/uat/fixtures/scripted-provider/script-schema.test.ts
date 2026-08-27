import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractCapture, loadChatScriptFixture, resolveCaptures } from "./script-schema.js";

// loadChatScriptFixture reads from a fixed FIXTURE_DIR relative to this module, so these tests
// write real fixture files under tests/uat/fixtures/chat-scripts/ using disposable ids, then clean
// them up — there's no injection seam for the directory (matches job-search-fixture-server's
// fixed-FIXTURE_DIR precedent, deliberately no test-only override).
const FIXTURE_DIR = join(import.meta.dirname, "..", "chat-scripts");

function writeFixture(id: string, content: unknown): void {
  writeFileSync(join(FIXTURE_DIR, `${id}.json`), JSON.stringify(content), "utf8");
}

function removeFixture(id: string): void {
  rmSync(join(FIXTURE_DIR, `${id}.json`), { force: true });
}

describe("loadChatScriptFixture", () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids.splice(0)) removeFixture(id);
  });

  it("loads and round-trips a valid minimal fixture", () => {
    ids.push("__test-minimal");
    writeFixture("__test-minimal", {
      version: 1,
      turns: [{ expectIncludes: ["hello"], calls: [], reply: "hi" }]
    });
    const fixture = loadChatScriptFixture("__test-minimal" as never);
    expect(fixture.version).toBe(1);
    expect(fixture.turns).toHaveLength(1);
    expect(fixture.turns[0]?.reply).toBe("hi");
  });

  it("throws distinctly for a missing file", () => {
    expect(() => loadChatScriptFixture("__test-missing" as never)).toThrow(/no fixture file/);
  });

  it("throws distinctly for malformed JSON", () => {
    ids.push("__test-malformed");
    writeFileSync(join(FIXTURE_DIR, "__test-malformed.json"), "{not json", "utf8");
    expect(() => loadChatScriptFixture("__test-malformed" as never)).toThrow(/not valid JSON/);
  });

  it("throws distinctly when version is not 1", () => {
    ids.push("__test-version");
    writeFixture("__test-version", { version: 2, turns: [] });
    expect(() => loadChatScriptFixture("__test-version" as never)).toThrow(/"version" must be 1/);
  });

  it("throws distinctly when turns is empty", () => {
    ids.push("__test-empty-turns");
    writeFixture("__test-empty-turns", { version: 1, turns: [] });
    expect(() => loadChatScriptFixture("__test-empty-turns" as never)).toThrow(/non-empty array/);
  });

  it("throws distinctly on an unknown top-level key", () => {
    ids.push("__test-unknown-key");
    writeFixture("__test-unknown-key", {
      version: 1,
      turns: [{ expectIncludes: [], calls: [], reply: "x" }],
      extra: true
    });
    expect(() => loadChatScriptFixture("__test-unknown-key" as never)).toThrow(
      /unknown key "extra"/
    );
  });

  it("loads a call with a valid expectedError", () => {
    ids.push("__test-expected-error");
    writeFixture("__test-expected-error", {
      version: 1,
      turns: [
        {
          expectIncludes: ["hello"],
          calls: [
            { tool: "notes.search", arguments: { query: "x" }, expectedError: "Tool failed" }
          ],
          reply: "sorry"
        }
      ]
    });
    const fixture = loadChatScriptFixture("__test-expected-error" as never);
    expect(fixture.turns[0]?.calls[0]?.expectedError).toBe("Tool failed");
  });

  it("throws distinctly on an empty expectedError", () => {
    ids.push("__test-empty-expected-error");
    writeFixture("__test-empty-expected-error", {
      version: 1,
      turns: [
        {
          expectIncludes: [],
          calls: [{ tool: "notes.search", arguments: {}, expectedError: "" }],
          reply: "x"
        }
      ]
    });
    expect(() => loadChatScriptFixture("__test-empty-expected-error" as never)).toThrow(
      /expectedError must be a non-empty string/
    );
  });

  it("throws distinctly on a reference to an undeclared capture", () => {
    ids.push("__test-undeclared-capture");
    writeFixture("__test-undeclared-capture", {
      version: 1,
      turns: [
        {
          expectIncludes: [],
          calls: [{ tool: "some_tool", arguments: { id: "${unknownCapture}" } }],
          reply: "x"
        }
      ]
    });
    expect(() => loadChatScriptFixture("__test-undeclared-capture" as never)).toThrow(
      /undeclared capture "\$\{unknownCapture\}"/
    );
  });
});

describe("extractCapture", () => {
  it("resolves an RFC 6901 JSON pointer into a call result", () => {
    const result = { content: [{ id: "abc123" }] };
    expect(extractCapture(result, "/content/0/id")).toBe("abc123");
  });

  it("throws on an invalid JSON pointer", () => {
    const result = { content: [] };
    expect(() => extractCapture(result, "/content/0/id")).toThrow(/does not resolve/);
  });
});

describe("resolveCaptures", () => {
  it("substitutes a known capture recursively inside nested arguments", () => {
    const captures = new Map<string, unknown>([["attachmentId", "att-1"]]);
    const resolved = resolveCaptures({ outer: { list: ["${attachmentId}", "literal"] } }, captures);
    expect(resolved).toEqual({ outer: { list: ["att-1", "literal"] } });
  });

  it("throws on an unknown capture name", () => {
    expect(() => resolveCaptures("${neverCaptured}", new Map())).toThrow(
      /unknown capture "\$\{neverCaptured\}"/
    );
  });
});
