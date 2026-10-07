import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { notesCreatePresentation } from "../../packages/notes/src/approval-presentation.js";
import { gatewayResponseToMcp } from "../../packages/chat/src/mcp-transport.js";
import { admissionFixture, admissionTool } from "./helpers/gateway-admission-fixture.js";
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataContextBrand, type DataContextDb } from "@moss/db";

const state = vi.hoisted(() => ({ source: "", roots: [] as string[] }));
vi.mock("@moss/settings", () => ({
  NOTES_SOURCE_PREFERENCE_KEY: "notes.source",
  resolveNotesRoots: () => state.roots
}));
vi.mock("@moss/structured-state", () => ({
  PreferencesRepository: class {
    async get() {
      return state.source;
    }
  }
}));
import { resolveNoteApprovalTarget } from "../../packages/notes/src/write-tools.js";

const db = { [dataContextBrand]: true, db: {} } as DataContextDb;
let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "moss-note-disclosure-"));
  root = join(base, "notes");
  await mkdir(root);
  state.source = root;
  state.roots = [root];
});
afterEach(async () => {
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
      if (condition === "unlinked") state.source = "";
      if (condition === "unavailable") state.source = join(base, "PRIVATE_MISSING_SOURCE");
      if (condition === "roots") state.roots = [];
      if (condition === "outside") state.source = base;
      await expect(
        resolveNoteApprovalTarget(db, "PRIVATE_NOTE_NAME.md", true)
      ).rejects.toMatchObject({ statusCode, message });
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
        deps: {
          yoloMode: async () => false,
          runner: {
            withDataContext: async (_access: unknown, callback: (value: unknown) => unknown) =>
              callback(db)
          } as never
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
    const relative = await resolveNoteApprovalTarget(db, "Plans/Friday.md", false);
    const absolute = await resolveNoteApprovalTarget(db, join(root, "Plans", "Friday.md"), false);
    expect(absolute).toEqual(relative);
    expect(relative.relative).toBe("Plans/Friday.md");
    expect(relative.version).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(root, "Plans", "Friday.md"), "Changed");
    expect((await resolveNoteApprovalTarget(db, "Plans/Friday.md", false)).version).not.toBe(
      relative.version
    );
  });

  it("binds a new note's absent state without creating directories or files", async () => {
    const before = await resolveNoteApprovalTarget(db, "New/Note.md", true);
    await expect(access(join(root, "New"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "New"));
    await writeFile(join(root, "New", "Note.md"), "");
    expect((await resolveNoteApprovalTarget(db, "New/Note.md", true)).version).not.toBe(
      before.version
    );
  });

  it("does not accept a missing file for edit/delete", async () => {
    await expect(resolveNoteApprovalTarget(db, "Absent.md", false)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("does not disclose files outside the linked source or an escaped parent", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "Private.md"), "Never disclose");
    await symlink(outside, join(root, "Escape"));
    await expect(resolveNoteApprovalTarget(db, "Escape/Private.md", false)).rejects.toThrow();
    await expect(resolveNoteApprovalTarget(db, "../outside/Private.md", false)).rejects.toThrow();
    await expect(
      resolveNoteApprovalTarget(db, join(outside, "Private.md"), false)
    ).rejects.toThrow();
  });

  it("rejects a linked source outside configured roots", async () => {
    state.source = base;
    await expect(resolveNoteApprovalTarget(db, "Private.md", true)).rejects.toThrow(
      "within an allowed"
    );
  });
});
