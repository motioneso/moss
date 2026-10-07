import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
