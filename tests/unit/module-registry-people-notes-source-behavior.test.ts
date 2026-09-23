import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DataContextDb, PreferencesPort } from "@moss/db";
import {
  getBuiltInModuleRegistrations,
  isPeopleNotesSuggestUpdatesEnabled
} from "@moss/module-registry";
import { PeopleNotesFolderUnavailableError, PeopleNotesService } from "@moss/people";
import { SOURCE_BEHAVIOR_PREFERENCE_KEY } from "@moss/source-behaviors";
import type { VaultContext } from "@moss/vault";
import type * as NotesModule from "@moss/notes";
import type * as StructuredStateModule from "@moss/structured-state";

const notesWorkerCapture = vi.hoisted(() => ({
  afterSync: undefined as
    | ((input: {
        readonly actorUserId: string;
        readonly sourcePath: string | null;
      }) => Promise<unknown>)
    | undefined
}));

// #2550: the People folder is stored as an absolute path inside the user's notes tree, so the
// after-sync hook must read it from preferences and root the vault there instead of at the
// private per-user vault. The PreferencesRepository mock below hands the hook this folder.
const peoplePrefs = vi.hoisted(() => ({ folder: null as string | null }));

vi.mock("@moss/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof NotesModule>();
  return {
    ...actual,
    registerNotesJobWorkers: vi.fn(
      async (
        _boss: unknown,
        _dataContext: unknown,
        options: {
          readonly afterSync?: (input: {
            readonly actorUserId: string;
            readonly sourcePath: string | null;
          }) => Promise<unknown>;
        }
      ) => {
        notesWorkerCapture.afterSync = options.afterSync;
        return ["notes-test-worker"];
      }
    )
  };
});

vi.mock("@moss/structured-state", async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredStateModule>();
  return {
    ...actual,
    PreferencesRepository: class extends actual.PreferencesRepository {
      override async get(scopedDb: DataContextDb, key: string): Promise<unknown> {
        void scopedDb;
        return key === "people-notes-folder" ? peoplePrefs.folder : null;
      }
    }
  };
});

const fakeScopedDb = { db: {} } as DataContextDb;

function prefRepo(values: Record<string, unknown>): PreferencesPort {
  return {
    get: async (_scopedDb, key) => values[key] ?? null,
    getWithMetadata: async () => null,
    upsert: async (_scopedDb, key, value) => {
      values[key] = value;
    }
  };
}

describe("People notes source behavior gate", () => {
  it("uses the built-in behavior default when no user override exists", async () => {
    await expect(isPeopleNotesSuggestUpdatesEnabled(fakeScopedDb, prefRepo({}))).resolves.toBe(
      true
    );
  });

  it("honors a user override that disables automatic People note updates", async () => {
    await expect(
      isPeopleNotesSuggestUpdatesEnabled(
        fakeScopedDb,
        prefRepo({
          [SOURCE_BEHAVIOR_PREFERENCE_KEY]: { "people.notes.suggest-updates": false }
        })
      )
    ).resolves.toBe(false);
  });
});

describe("People notes after-sync recovery", () => {
  let vaultRoot = "";
  let peopleFolder = "";
  const previousVaultRoot = process.env["JARVIS_VAULT_ROOT"];
  const previousNotesRoots = process.env["MOSS_NOTES_ROOTS"];

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-people-after-sync-"));
    process.env["JARVIS_VAULT_ROOT"] = vaultRoot;
    // The People folder lives in the notes tree, outside the private per-user vault, and must
    // sit inside a configured notes root for withVaultContextAt to accept it (#2550 / #2268).
    peopleFolder = join(vaultRoot, "notes", "People");
    await mkdir(peopleFolder, { recursive: true });
    process.env["MOSS_NOTES_ROOTS"] = join(vaultRoot, "notes");
    peoplePrefs.folder = peopleFolder;

    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === "notes"
    );
    const dataContext = {
      withDataContext: async (_accessContext: unknown, work: (db: DataContextDb) => unknown) =>
        work(fakeScopedDb)
    };
    await registration?.registerWorkers?.({} as never, {
      rootDb: {} as never,
      dataContext: dataContext as never
    });
  });

  afterAll(async () => {
    if (previousVaultRoot === undefined) delete process.env["JARVIS_VAULT_ROOT"];
    else process.env["JARVIS_VAULT_ROOT"] = previousVaultRoot;
    if (previousNotesRoots === undefined) delete process.env["MOSS_NOTES_ROOTS"];
    else process.env["MOSS_NOTES_ROOTS"] = previousNotesRoots;
    if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  });

  it("roots the People refresh at the configured People folder, never the private vault", async () => {
    const refresh = vi
      .spyOn(PeopleNotesService.prototype, "refreshFromFolder")
      .mockResolvedValue({ discovered: 0, projected: 0, ignored: 0, candidates: 0 });
    await notesWorkerCapture.afterSync?.({ actorUserId: "user-a", sourcePath: null });
    expect(refresh).toHaveBeenCalledTimes(1);
    const vaultCtx = refresh.mock.calls[0]?.[1] as VaultContext | undefined;
    expect(vaultCtx?.vaultRoot).toBe(await realpath(peopleFolder));
    expect(vaultCtx?.vaultRoot).not.toBe(join(vaultRoot, "user-a"));
    refresh.mockRestore();
  });

  it("catches only unavailable People folders", async () => {
    expect(notesWorkerCapture.afterSync).toBeTypeOf("function");
    const refresh = vi.spyOn(PeopleNotesService.prototype, "refreshFromFolder");
    refresh.mockRejectedValueOnce(new PeopleNotesFolderUnavailableError());
    await expect(
      notesWorkerCapture.afterSync?.({ actorUserId: "user-a", sourcePath: null })
    ).resolves.toBeUndefined();

    refresh.mockRejectedValueOnce(new Error("database failed"));
    await expect(
      notesWorkerCapture.afterSync?.({ actorUserId: "user-a", sourcePath: null })
    ).rejects.toThrow("database failed");
    refresh.mockRestore();
  });
});
