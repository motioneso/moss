import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { PreferencesRepository } from "@moss/structured-state";
import { PeopleNotesService } from "@moss/people";

/**
 * #2268 — a People folder saved before this change was a relative name inside the app's private
 * storage. It now resolves against the user's chosen notes folder, but only when that folder is
 * set and the subfolder really exists; anything else returns nothing so the People screen can
 * show its existing "choose another folder" state instead of guessing.
 */
const preferences = new Map<string, unknown>();

const fakePreferences = {
  async get(_db: DataContextDb, key: string) {
    return preferences.get(key) ?? null;
  }
} as unknown as PreferencesRepository;

const scopedDb = {} as DataContextDb;

function makeService() {
  return new PeopleNotesService({ preferencesRepository: fakePreferences });
}

describe("resolving a People folder saved before the shared picker", () => {
  beforeEach(() => {
    preferences.clear();
  });

  it("returns nothing when no folder has been chosen", async () => {
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("returns an absolute saved folder unchanged", async () => {
    preferences.set("people-notes-folder", "/data/external-notes/People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBe(
      "/data/external-notes/People"
    );
  });

  it("resolves a relative saved folder against the chosen notes folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    await mkdir(join(root, "People"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBe(join(root, "People"));
  });

  it("returns nothing when no notes folder has been chosen", async () => {
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("returns nothing when the folder does not exist inside the notes folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("returns nothing when the saved name points at a file rather than a folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    await writeFile(join(root, "People"), "not a folder");
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "People");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });

  it("refuses a saved name that climbs out of the notes folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "people-legacy-"));
    preferences.set("notes-source-path", root);
    preferences.set("people-notes-folder", "../elsewhere");
    await expect(makeService().resolveFolder(scopedDb)).resolves.toBeNull();
  });
});
