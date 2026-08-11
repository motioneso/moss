import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCursor, writeCursor } from "./session-state.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uat-chat-script-state-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("session-state", () => {
  it("round-trips a written cursor", () => {
    const cursor = { scriptId: "phase1-smoke", turnIndex: 2, captures: { firstAttachmentId: "att-1" } };
    writeCursor(stateDir, "session-a", cursor);
    expect(readCursor(stateDir, "session-a")).toEqual(cursor);
  });

  it("reports a missing prior cursor as undefined", () => {
    expect(readCursor(stateDir, "never-written")).toBeUndefined();
  });

  it("reports a malformed prior cursor as undefined", () => {
    writeCursor(stateDir, "session-b", { scriptId: "x", turnIndex: 0, captures: {} });
    // overwrite with a shape mismatch a caller could plausibly write by mistake
    writeCursor(stateDir, "session-b", { scriptId: 5 as unknown as string, turnIndex: 0, captures: {} });
    expect(readCursor(stateDir, "session-b")).toBeUndefined();
  });

  it("writes the cursor file with mode 0600", () => {
    writeCursor(stateDir, "session-c", { scriptId: "phase1-smoke", turnIndex: 0, captures: {} });
    const mode = statSync(join(stateDir, "session-c.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
