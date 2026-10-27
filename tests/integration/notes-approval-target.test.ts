import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { notesCreatePresentation } from "../../packages/notes/src/approval-presentation.js";
import { gatewayResponseToMcp } from "../../packages/chat/src/mcp-transport.js";
import { admissionFixture, admissionTool } from "../unit/helpers/gateway-admission-fixture.js";
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase, DataContextRunner } from "@moss/db";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { resolveNoteApprovalTarget } from "../../packages/notes/src/write-tools.js";

const db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const runner = new DataContextRunner(db);
const actor = { actorUserId: ids.userA, requestId: "approval-target" };
beforeAll(resetFoundationDatabase);
afterAll(() => db.destroy());
function setSource(source: string) {
  return runner.withDataContext(actor, (scopedDb) =>
    new PreferencesRepository().upsert(scopedDb, NOTES_SOURCE_PREFERENCE_KEY, source)
  );
}
function resolveTarget(path: string, allowNew: boolean) {
  return runner.withDataContext(actor, (scopedDb) =>
    resolveNoteApprovalTarget(scopedDb, path, allowNew)
  );
}
let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "moss-note-disclosure-"));
  root = join(base, "notes");
  await mkdir(root);
  await setSource(root);
  vi.stubEnv("MOSS_NOTES_ROOTS", root);
  vi.stubEnv("JARVIS_NOTES_ROOTS", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

describe("note approval target resolution", () => {
  it.each([
    ["unlinked", 409, "Notes source is not configured"],
    ["unavailable", 400, "Notes source path does not exist or cannot be resolved"],
    ["roots", 503, "Notes roots not configured on this server"],
    ["outside", 400, "Notes source path is not within an allowed notes root"]
  ] as const)(
    "returns the safe %s prerequisite to the model before a card or write",
    async (condition, statusCode, message) => {
      if (condition === "unlinked") await setSource("");
      if (condition === "unavailable") await setSource(join(base, "PRIVATE_MISSING_SOURCE"));
      if (condition === "roots") {
        vi.stubEnv("MOSS_NOTES_ROOTS", "");
        vi.stubEnv("JARVIS_NOTES_ROOTS", "");
      }
      if (condition === "outside") await setSource(base);
      await expect(resolveTarget("PRIVATE_NOTE_NAME.md", true)).rejects.toMatchObject({
        statusCode,
        message
      });
      const tool = admissionTool("notes.create", {
        risk: "write",
        executionPolicy: "confirm",
        actionLabel: "Create note",
        approvalPresentation: notesCreatePresentation,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"]
        }
      });
      const h = admissionFixture([tool], {
        actorUserId: ids.userA,
        deps: {
          yoloMode: async () => false,
          runner
        }
      });
      const response = await h.gateway.callTool(h.token, "notes.create", {
        path: "PRIVATE_NOTE_NAME.md",
        content: "PRIVATE_PROPOSED_CONTENT"
      });
      const parsed = CallToolResultSchema.parse(gatewayResponseToMcp(response));
      expect(parsed).toEqual({
        isError: true,
        content: [{ type: "text", text: message }]
      });
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
      expect(JSON.stringify(parsed)).not.toContain(base);
      expect(h.createPending).not.toHaveBeenCalled();
      expect(tool.execute).not.toHaveBeenCalled();
      expect(h.records).toEqual([]);
    }
  );

  it("resolves a linked source absolute path to an exact relative destination", async () => {
    await mkdir(join(root, "Plans"));
    await writeFile(join(root, "Plans", "Friday.md"), "Original");
    const relative = await resolveTarget("Plans/Friday.md", false);
    const absolute = await resolveTarget(join(root, "Plans", "Friday.md"), false);
    expect(absolute).toEqual(relative);
    expect(relative.relative).toBe("Plans/Friday.md");
    expect(relative.version).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(root, "Plans", "Friday.md"), "Changed");
    expect((await resolveTarget("Plans/Friday.md", false)).version).not.toBe(relative.version);
  });

  it("binds a new note's absent state without creating directories or files", async () => {
    const before = await resolveTarget("New/Note.md", true);
    await expect(access(join(root, "New"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "New"));
    await writeFile(join(root, "New", "Note.md"), "");
    expect((await resolveTarget("New/Note.md", true)).version).not.toBe(before.version);
  });

  it("does not accept a missing file for edit/delete", async () => {
    await expect(resolveTarget("Absent.md", false)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("does not disclose files outside the linked source or an escaped parent", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "Private.md"), "Never disclose");
    await symlink(outside, join(root, "Escape"));
    await expect(resolveTarget("Escape/Private.md", false)).rejects.toThrow();
    await expect(resolveTarget("../outside/Private.md", false)).rejects.toThrow();
    await expect(resolveTarget(join(outside, "Private.md"), false)).rejects.toThrow();
  });

  it("rejects a linked source outside configured roots", async () => {
    await setSource(base);
    await expect(resolveTarget("Private.md", true)).rejects.toThrow("within an allowed");
  });
});
