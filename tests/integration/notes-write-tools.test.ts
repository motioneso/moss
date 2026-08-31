import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kysely } from "kysely";
import type * as NodeFsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TOCTOU test support: vi.spyOn cannot patch the "node:fs/promises" namespace directly (ESM
// module namespaces aren't configurable), so realpath/readFile are routed through these mocks
// via vi.mock instead. Every other export passes through to the real implementation untouched.
// vi.hoisted is required (not a plain top-level const) because vi.mock factories are hoisted
// above all imports, including any plain variable declarations that would otherwise sit below them.
type FsPromises = typeof NodeFsPromises;

const fsMocks = vi.hoisted(() => ({
  realpathMock: vi.fn(),
  readFileFsMock: vi.fn(),
  actualFs: undefined as unknown
}));
const { realpathMock, readFileFsMock } = fsMocks;
function actualFs(): FsPromises {
  return fsMocks.actualFs as FsPromises;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<FsPromises>();
  fsMocks.actualFs = actual;
  // Default to a transparent passthrough from the moment the module loads — code that runs
  // before this file's beforeEach (foundation DB reset/migrations) also goes through these
  // mocks, so an unconfigured vi.fn() here would return undefined and corrupt unrelated I/O.
  // Referenced via fsMocks (not the destructured consts below) because this factory is hoisted
  // above that destructuring statement and would otherwise hit the TDZ.
  fsMocks.realpathMock.mockImplementation(actual.realpath);
  fsMocks.readFileFsMock.mockImplementation(actual.readFile);
  return {
    ...actual,
    realpath: (...args: Parameters<FsPromises["realpath"]>) => fsMocks.realpathMock(...args),
    readFile: (...args: Parameters<FsPromises["readFile"]>) => fsMocks.readFileFsMock(...args)
  };
});

import { buildChatToolServices } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import {
  notesModuleManifest,
  notesCreateExecute,
  notesDeleteExecute,
  notesEditExecute,
  type NotesSyncToolService
} from "@moss/notes";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("notes write assistant tools", () => {
  const prefs = new PreferencesRepository();
  let runner: DataContextRunner;
  let root: string;
  let db: Kysely<MossDatabase>;
  let syncs: string[];
  let service: NotesSyncToolService;

  beforeEach(async () => {
    realpathMock.mockImplementation((p: Parameters<FsPromises["realpath"]>[0]) =>
      actualFs().realpath(p)
    );
    readFileFsMock.mockImplementation((...args: Parameters<FsPromises["readFile"]>) =>
      actualFs().readFile(...args)
    );
    await resetFoundationDatabase();
    db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(db);
    root = await mkdtemp(join(tmpdir(), `jarv1s-notes-write-${randomUUID()}-`));
    process.env["JARVIS_NOTES_ROOTS"] = root;
    syncs = [];
    service = {
      enqueue: async (actorUserId, sourcePath) => {
        syncs.push(`${actorUserId}:${sourcePath}`);
        return "job-1";
      }
    };
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "seed" }, (scopedDb) =>
      prefs.upsert(scopedDb, NOTES_SOURCE_PREFERENCE_KEY, root)
    );
  });

  afterEach(async () => {
    delete process.env["JARVIS_NOTES_ROOTS"];
    vi.restoreAllMocks();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });

  it("declares create/edit/delete as auto write tools", () => {
    const tools = new Map<string, NonNullable<MossModuleManifest["assistantTools"]>[number]>(
      (notesModuleManifest.assistantTools ?? []).map((tool) => [tool.name, tool])
    );
    expect(tools.get("notes.create")?.risk).toBe("write");
    expect(tools.get("notes.create")?.executionPolicy).toBe("auto");
    expect(tools.get("notes.create")?.safeErrors).toBe(true);
    expect(tools.get("notes.edit")?.risk).toBe("write");
    expect(tools.get("notes.edit")?.executionPolicy).toBe("auto");
    expect(tools.get("notes.edit")?.safeErrors).toBe(true);
    expect(tools.get("notes.delete")?.risk).toBe("write");
    expect(tools.get("notes.delete")?.executionPolicy).toBe("auto");
    expect(tools.get("notes.delete")?.safeErrors).toBe(true);
    expect(tools.get("notes.search")?.safeErrors).toBeUndefined();
    expect(
      tools.get("notes.delete")?.summarize?.(
        { path: "x.md" },
        {
          actorUserId: ids.userA,
          requestId: "r",
          chatSessionId: "c"
        }
      )
    ).toContain("x.md");
  });

  it("grants notes.create, notes.edit, and notes.delete at install", () => {
    const tools = new Map<string, NonNullable<MossModuleManifest["assistantTools"]>[number]>(
      (notesModuleManifest.assistantTools ?? []).map((tool) => [tool.name, tool])
    );
    expect(tools.get("notes.create")?.selfOperationGrant).toBe("granted_at_install");
    expect(tools.get("notes.edit")?.selfOperationGrant).toBe("granted_at_install");
    // notes.delete: Ben's ruling (2026-07-26) — "approve once, don't need to baby proof."
    // granted_at_install plus risk: "write" so it can actually auto-run once granted; the
    // note_changes family still allows always_confirm for a user who wants a prompt back.
    expect(tools.get("notes.delete")?.selfOperationGrant).toBe("granted_at_install");
    expect(tools.get("notes.delete")?.risk).toBe("write");
    expect(tools.get("notes.delete")?.executionPolicy).toBe("auto");
  });

  it("discloses overwrite in notes.create summary and flags it as always-confirm", async () => {
    const tools = new Map<string, NonNullable<MossModuleManifest["assistantTools"]>[number]>(
      (notesModuleManifest.assistantTools ?? []).map((tool) => [tool.name, tool])
    );
    const create = tools.get("notes.create");
    const ctx = { actorUserId: ids.userA, requestId: "r", chatSessionId: "c" };

    expect(create?.summarize?.({ path: "x.md" }, ctx)).toBe("Create note x.md.");
    expect(create?.summarize?.({ path: "x.md", overwrite: true }, ctx)).toBe(
      "Overwrite note x.md (replaces existing content)."
    );

    expect(await create?.requiresConfirmation?.({} as never, { path: "x.md" }, ctx)).toBe(false);
    expect(
      await create?.requiresConfirmation?.({} as never, { path: "x.md", overwrite: true }, ctx)
    ).toBe(true);
  });

  it("chat tool services include notesSync when boss is provided", async () => {
    const sent: unknown[] = [];
    const boss = {
      send: async (...args: unknown[]) => {
        sent.push(args);
        return "job-123";
      }
    };
    const services = buildChatToolServices({ boss: boss as never });
    const notesSync = services.notesSync as NotesSyncToolService;
    await notesSync.enqueue(ids.userA, "/notes");
    expect(sent[0]).toBeTruthy();
  });

  it("gateway auto-runs create/edit/delete under trusted_auto", async () => {
    const emitted: unknown[] = [];
    const { AiRepository, AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } =
      await import("@moss/ai");
    const repository = new AiRepository();
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [notesModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 30_000,

      actionPolicy: () => ({
        getFamilyTier: async (moduleId, familyId) => "trusted_auto",
        getFamilyManifest: async () => ({
          id: "note_changes",
          label: "Note Changes",
          description: "Modify notes.",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        })
      }),
      toolServices: { notesSync: service }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "notes-chat",
      allowedToolNames: null
    });

    const created = await gateway.callTool(token, "notes.create", {
      path: "auto.md",
      content: "hello old"
    });
    expect(created.ok).toBe(true);

    const edited = await gateway.callTool(token, "notes.edit", {
      path: "auto.md",
      oldText: "old",
      newText: "new"
    });
    expect(edited.ok).toBe(true);

    const deleted = await gateway.callTool(token, "notes.delete", { path: "auto.md" });
    expect(deleted.ok).toBe(true);
    expect(emitted.some((r) => (r as { kind?: string }).kind === "action_request")).toBe(false);
  });

  it("gateway forces confirmation for a notes.create overwrite even under trusted_auto", async () => {
    await writeFile(join(root, "existing.md"), "original content");

    const emitted: unknown[] = [];
    const { AiRepository, AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } =
      await import("@moss/ai");
    const repository = new AiRepository();
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [notesModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (_chatSessionId, record) => emitted.push(record) },
      confirmTimeoutMs: 30_000,

      actionPolicy: () => ({
        getFamilyTier: async (moduleId, familyId) => "trusted_auto",
        getFamilyManifest: async () => ({
          id: "note_changes",
          label: "Note Changes",
          description: "Modify notes.",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        })
      }),
      toolServices: { notesSync: service }
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "notes-chat-overwrite",
      allowedToolNames: null
    });

    // Ordinary create of a new file still auto-runs under trusted_auto (no regression).
    const created = await gateway.callTool(token, "notes.create", {
      path: "brand-new.md",
      content: "hello"
    });
    expect(created.ok).toBe(true);

    // overwrite:true on an existing note must NOT auto-run, even though the family is
    // trusted_auto and executionPolicy is "auto" — this is the data-loss disclosure fix.
    const overwritePromise = gateway.callTool(token, "notes.create", {
      path: "existing.md",
      content: "replaced content",
      overwrite: true
    });
    await vi.waitFor(() => {
      expect(emitted.some((r) => (r as { kind?: string }).kind === "action_request")).toBe(true);
    });
    const request = emitted.find((r) => (r as { kind?: string }).kind === "action_request") as {
      actionRequestId: string;
      summary: string;
    };
    expect(request.summary).toContain("Overwrite note existing.md");
    expect(request.summary).toContain("replaces existing content");

    // Must remain untouched while pending confirmation.
    await expect(readFile(join(root, "existing.md"), "utf-8")).resolves.toBe("original content");

    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    const overwritten = await overwritePromise;
    expect(overwritten.ok).toBe(true);
    await expect(readFile(join(root, "existing.md"), "utf-8")).resolves.toBe("replaced content");
  });

  it("creates a new markdown note and enqueues sync", async () => {
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "create" }, async (db) => {
      const result = await notesCreateExecute(
        db,
        { path: "ideas/new.md", content: "# New\n" },
        { actorUserId: ids.userA, requestId: "create", chatSessionId: "chat" },
        { notesSync: service }
      );
      expect(result.data).toEqual({ path: "ideas/new.md", synced: true });
    });

    await expect(readFile(join(root, "ideas/new.md"), "utf-8")).resolves.toBe("# New\n");
    expect(syncs).toEqual([`${ids.userA}:${root}`]);
  });

  it("does not overwrite an existing note unless requested", async () => {
    await mkdir(join(root, "ideas"), { recursive: true });
    await writeFile(join(root, "ideas/new.md"), "first");
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "create" }, async (db) => {
      await expect(
        notesCreateExecute(
          db,
          { path: "ideas/new.md", content: "second" },
          { actorUserId: ids.userA, requestId: "create", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("already exists");
    });
  });

  it("overwrites an existing note when requested", async () => {
    await mkdir(join(root, "ideas"), { recursive: true });
    await writeFile(join(root, "ideas/new.md"), "first");
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "create" }, async (db) => {
      const result = await notesCreateExecute(
        db,
        { path: "ideas/new.md", content: "second", overwrite: true },
        { actorUserId: ids.userA, requestId: "create", chatSessionId: "chat" },
        { notesSync: service }
      );
      expect(result.data).toEqual({ path: "ideas/new.md", synced: true });
    });

    await expect(readFile(join(root, "ideas/new.md"), "utf-8")).resolves.toBe("second");
    expect(syncs).toEqual([`${ids.userA}:${root}`]);
  });

  it("edits only when oldText appears exactly once", async () => {
    await writeFile(join(root, "note.md"), "alpha beta alpha");
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "edit" }, async (db) => {
      await expect(
        notesEditExecute(
          db,
          { path: "note.md", oldText: "alpha", newText: "omega" },
          { actorUserId: ids.userA, requestId: "edit", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("appears 2 times");
    });
  });

  it("rejects empty oldText on a short file where count-based check would slip through", async () => {
    // With the old `content.split(oldText).length - 1 !== 1` guard, a 2-character file made
    // `count` equal exactly 1 for oldText === "" ("ab".split("") has 2 elements, count = 1), so
    // the "appears once" check passed and replace("", newText) silently prepended newText. This
    // must now be rejected outright, before that check ever runs.
    await writeFile(join(root, "short.md"), "ab");
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "edit-empty" },
      async (db) => {
        await expect(
          notesEditExecute(
            db,
            { path: "short.md", oldText: "", newText: "PREPENDED" },
            { actorUserId: ids.userA, requestId: "edit-empty", chatSessionId: "chat" },
            { notesSync: service }
          )
        ).rejects.toThrow("oldText must be non-empty");
      }
    );
    await expect(readFile(join(root, "short.md"), "utf-8")).resolves.toBe("ab");
  });

  it("rejects empty oldText regardless of file length", async () => {
    await writeFile(join(root, "long.md"), "alpha beta gamma delta".repeat(10));
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "edit-empty-2" },
      async (db) => {
        await expect(
          notesEditExecute(
            db,
            { path: "long.md", oldText: "", newText: "PREPENDED" },
            { actorUserId: ids.userA, requestId: "edit-empty-2", chatSessionId: "chat" },
            { notesSync: service }
          )
        ).rejects.toThrow("oldText must be non-empty");
      }
    );
  });

  it("deletes a markdown note and enqueues sync", async () => {
    await writeFile(join(root, "note.md"), "delete me");
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "delete" }, async (db) => {
      const result = await notesDeleteExecute(
        db,
        { path: "note.md" },
        { actorUserId: ids.userA, requestId: "delete", chatSessionId: "chat" },
        { notesSync: service }
      );
      expect(result.data).toEqual({ path: "note.md", synced: true });
    });
    await expect(readFile(join(root, "note.md"), "utf-8")).rejects.toThrow();
  });

  it("accepts absolute sourcePath from search results (within root) and writes correctly", async () => {
    const absPath = join(root, "journal/2026-06-29.md");
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "abs-create" },
      async (db) => {
        const result = await notesCreateExecute(
          db,
          { path: absPath, content: "# Today\n" },
          { actorUserId: ids.userA, requestId: "abs-create", chatSessionId: "chat" },
          { notesSync: service }
        );
        expect(result.data).toEqual({ path: "journal/2026-06-29.md", synced: true });
      }
    );
    await expect(readFile(absPath, "utf-8")).resolves.toBe("# Today\n");

    await runner.withDataContext({ actorUserId: ids.userA, requestId: "abs-edit" }, async (db) => {
      const result = await notesEditExecute(
        db,
        { path: absPath, oldText: "# Today\n", newText: "# Today (edited)\n" },
        { actorUserId: ids.userA, requestId: "abs-edit", chatSessionId: "chat" },
        { notesSync: service }
      );
      expect(result.data).toEqual({ path: "journal/2026-06-29.md", synced: true });
    });
    await expect(readFile(absPath, "utf-8")).resolves.toBe("# Today (edited)\n");

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "abs-delete" },
      async (db) => {
        const result = await notesDeleteExecute(
          db,
          { path: absPath },
          { actorUserId: ids.userA, requestId: "abs-delete", chatSessionId: "chat" },
          { notesSync: service }
        );
        expect(result.data).toEqual({ path: "journal/2026-06-29.md", synced: true });
      }
    );
    await expect(readFile(absPath, "utf-8")).rejects.toThrow();
  });

  it("rejects absolute path with traversal after root prefix (sibling-prefix attack)", async () => {
    // e.g. AI passes /root/../../../etc/passwd.md — coerceToRelativePath strips /root/ prefix
    // leaving ../../../etc/passwd.md which must be caught by the `..` check in requireMarkdownPath
    // Must use string concat — join() normalises `..` away before coerceToRelativePath sees it.
    const traversalPath = `${root}/../../../etc/passwd.md`;
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "abs-traversal" },
      async (db) => {
        await expect(
          notesCreateExecute(
            db,
            { path: traversalPath, content: "bad" },
            { actorUserId: ids.userA, requestId: "abs-traversal", chatSessionId: "chat" },
            { notesSync: service }
          )
        ).rejects.toThrow("relative Markdown path");
      }
    );
  });

  it("rejects absolute path outside the configured notes root", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-abs-${randomUUID()}-`));
    try {
      const absOutsidePath = join(outside, "escape.md");
      await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "abs-outside" },
        async (db) => {
          await expect(
            notesCreateExecute(
              db,
              { path: absOutsidePath, content: "bad" },
              { actorUserId: ids.userA, requestId: "abs-outside", chatSessionId: "chat" },
              { notesSync: service }
            )
          ).rejects.toThrow("relative Markdown path");
        }
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlink escape", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-${randomUUID()}-`));
    await symlink(outside, join(root, "escape"));
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "guard" }, async (db) => {
      await expect(
        notesCreateExecute(
          db,
          { path: "../bad.md", content: "bad" },
          { actorUserId: ids.userA, requestId: "guard", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("relative Markdown path");
      await expect(
        notesCreateExecute(
          db,
          { path: "escape/sub/bad.md", content: "bad" },
          { actorUserId: ids.userA, requestId: "guard", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
      await expect(lstat(join(outside, "sub"))).rejects.toThrow();
      await writeFile(join(outside, "bad.md"), "outside");
      await symlink(join(outside, "bad.md"), join(root, "linked.md"));
      await expect(
        notesCreateExecute(
          db,
          { path: "linked.md", content: "bad", overwrite: true },
          { actorUserId: ids.userA, requestId: "guard", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path must reference a Markdown file");
      await expect(readFile(join(outside, "bad.md"), "utf-8")).resolves.toBe("outside");
      await expect(
        notesEditExecute(
          db,
          { path: "escape/bad.md", oldText: "outside", newText: "changed" },
          { actorUserId: ids.userA, requestId: "guard", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
      await expect(readFile(join(outside, "bad.md"), "utf-8")).resolves.toBe("outside");
      await expect(
        notesDeleteExecute(
          db,
          { path: "escape/bad.md" },
          { actorUserId: ids.userA, requestId: "guard", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
      await expect(readFile(join(outside, "bad.md"), "utf-8")).resolves.toBe("outside");
    });
    await rm(outside, { recursive: true, force: true });
  });

  it("narrows the TOCTOU window: create overwrite, parent swapped to a symlink after the parent check, before writeFile", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-toctou1-${randomUUID()}-`));
    const parentDir = join(root, "sub1");
    await mkdir(parentDir, { recursive: true });
    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === parentDir) {
        await rm(parentDir, { recursive: true, force: true });
        await symlink(outside, parentDir);
      }
      return resolved;
    });
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "toctou-1" }, async (db) => {
      await expect(
        notesCreateExecute(
          db,
          { path: "sub1/note.md", content: "escaped", overwrite: true },
          { actorUserId: ids.userA, requestId: "toctou-1", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
    });
    await expect(readFile(join(outside, "note.md"), "utf-8")).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });

  it("narrows the TOCTOU window: create exclusive, parent swapped to a symlink after the parent check, before open", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-toctou2-${randomUUID()}-`));
    const parentDir = join(root, "sub2");
    await mkdir(parentDir, { recursive: true });
    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === parentDir) {
        await rm(parentDir, { recursive: true, force: true });
        await symlink(outside, parentDir);
      }
      return resolved;
    });
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "toctou-2" }, async (db) => {
      await expect(
        notesCreateExecute(
          db,
          { path: "sub2/note2.md", content: "escaped" },
          { actorUserId: ids.userA, requestId: "toctou-2", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
    });
    await expect(readFile(join(outside, "note2.md"), "utf-8")).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });

  it("narrows the TOCTOU window: edit, target swapped to a symlink after resolveExistingFile, before readFile", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-toctou3-${randomUUID()}-`));
    await writeFile(join(outside, "secret.md"), "TOP SECRET");
    const targetPath = join(root, "note3.md");
    await writeFile(targetPath, "TOP SECRET");
    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === targetPath) {
        await rm(targetPath, { force: true });
        await symlink(join(outside, "secret.md"), targetPath);
      }
      return resolved;
    });
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "toctou-3" }, async (db) => {
      await expect(
        notesEditExecute(
          db,
          { path: "note3.md", oldText: "TOP SECRET", newText: "leaked" },
          { actorUserId: ids.userA, requestId: "toctou-3", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
    });
    await expect(readFile(join(outside, "secret.md"), "utf-8")).resolves.toBe("TOP SECRET");
    await rm(outside, { recursive: true, force: true });
  });

  it("narrows the TOCTOU window: edit, target swapped to a symlink after readFile succeeds, before writeFile", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-toctou4-${randomUUID()}-`));
    const targetPath = join(root, "note4.md");
    await writeFile(targetPath, "hello world");
    readFileFsMock.mockImplementation(async (...args: Parameters<FsPromises["readFile"]>) => {
      const result = await actualFs().readFile(...args);
      if (args[0] === targetPath) {
        await rm(targetPath, { force: true });
        await symlink(join(outside, "note4.md"), targetPath);
      }
      return result;
    });
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "toctou-4" }, async (db) => {
      await expect(
        notesEditExecute(
          db,
          { path: "note4.md", oldText: "hello", newText: "goodbye" },
          { actorUserId: ids.userA, requestId: "toctou-4", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
    });
    await expect(readFile(join(outside, "note4.md"), "utf-8")).rejects.toThrow();
    await rm(outside, { recursive: true, force: true });
  });

  it("narrows the TOCTOU window: delete, parent swapped to a symlink after resolveExistingFile, before unlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), `jarv1s-outside-toctou5-${randomUUID()}-`));
    await writeFile(join(outside, "note5.md"), "do not delete me");
    const parentDir = join(root, "sub5");
    await mkdir(parentDir, { recursive: true });
    const targetPath = join(parentDir, "note5.md");
    await writeFile(targetPath, "delete me");
    realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
      const resolved = await actualFs().realpath(p);
      if (p === targetPath) {
        await rm(parentDir, { recursive: true, force: true });
        await symlink(outside, parentDir);
      }
      return resolved;
    });
    await runner.withDataContext({ actorUserId: ids.userA, requestId: "toctou-5" }, async (db) => {
      await expect(
        notesDeleteExecute(
          db,
          { path: "sub5/note5.md" },
          { actorUserId: ids.userA, requestId: "toctou-5", chatSessionId: "chat" },
          { notesSync: service }
        )
      ).rejects.toThrow("path is not within the linked notes source");
    });
    await expect(readFile(join(outside, "note5.md"), "utf-8")).resolves.toBe("do not delete me");
    await rm(outside, { recursive: true, force: true });
  });

  describe("concurrent edits", () => {
    // The outer `db`/`runner` pair uses maxConnections: 1 — a single withDataContext call
    // holds the only pool connection for its whole transaction, so two overlapping calls on it
    // would deadlock on connection acquisition (unrelated to the mutex under test). Use a
    // dedicated pool of 2 here so both concurrent notesEditExecute calls can each hold their
    // own transaction while they race for the path lock.
    let concurrentDb: Kysely<MossDatabase>;
    let concurrentRunner: DataContextRunner;

    beforeEach(() => {
      concurrentDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
      concurrentRunner = new DataContextRunner(concurrentDb);
    });

    afterEach(async () => {
      await concurrentDb.destroy();
    });

    // Barrier: both concurrent notesEditExecute calls must have genuinely entered
    // resolveExistingFile's realpath call (write-tools.ts:119) — before either lock/critical-
    // section code below can possibly run. Gating here (not on readFile) avoids deadlock
    // regardless of whether the mutex under test is implemented correctly or missing entirely.
    function armEntryBarrier(targetPath: string): void {
      let entered = 0;
      let releaseGate: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      realpathMock.mockImplementation(async (p: Parameters<FsPromises["realpath"]>[0]) => {
        const resolved = await actualFs().realpath(p);
        if (p === targetPath) {
          entered += 1;
          if (entered === 2) releaseGate();
          await gate;
        }
        return resolved;
      });
    }

    it("disjoint overlapping edits on one file both succeed", async () => {
      const targetPath = join(root, "concurrent1.md");
      await writeFile(targetPath, "APPLE and BANANA are fruits");
      armEntryBarrier(targetPath);

      const [result1, result2] = await Promise.all([
        concurrentRunner.withDataContext({ actorUserId: ids.userA, requestId: "conc-1a" }, (db) =>
          notesEditExecute(
            db,
            { path: "concurrent1.md", oldText: "APPLE", newText: "ORANGE" },
            { actorUserId: ids.userA, requestId: "conc-1a", chatSessionId: "chat" },
            { notesSync: service }
          )
        ),
        concurrentRunner.withDataContext({ actorUserId: ids.userA, requestId: "conc-1b" }, (db) =>
          notesEditExecute(
            db,
            { path: "concurrent1.md", oldText: "BANANA", newText: "GRAPE" },
            { actorUserId: ids.userA, requestId: "conc-1b", chatSessionId: "chat" },
            { notesSync: service }
          )
        )
      ]);
      expect(result1.data).toMatchObject({ synced: true });
      expect(result2.data).toMatchObject({ synced: true });

      const finalContent = await readFile(targetPath, "utf-8");
      expect(finalContent).toContain("ORANGE");
      expect(finalContent).toContain("GRAPE");
    });

    it("overlapping same-substring edits: exactly one succeeds, the other gets 409", async () => {
      const targetPath = join(root, "concurrent2.md");
      await writeFile(targetPath, "hello world");
      armEntryBarrier(targetPath);

      const outcomes = await Promise.allSettled([
        concurrentRunner.withDataContext({ actorUserId: ids.userA, requestId: "conc-2a" }, (db) =>
          notesEditExecute(
            db,
            { path: "concurrent2.md", oldText: "hello", newText: "goodbye1" },
            { actorUserId: ids.userA, requestId: "conc-2a", chatSessionId: "chat" },
            { notesSync: service }
          )
        ),
        concurrentRunner.withDataContext({ actorUserId: ids.userA, requestId: "conc-2b" }, (db) =>
          notesEditExecute(
            db,
            { path: "concurrent2.md", oldText: "hello", newText: "goodbye2" },
            { actorUserId: ids.userA, requestId: "conc-2b", chatSessionId: "chat" },
            { notesSync: service }
          )
        )
      ]);

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringMatching(/appears 0 times/)
      });

      const finalContent = await readFile(targetPath, "utf-8");
      const isWinner1 = finalContent === "goodbye1 world";
      const isWinner2 = finalContent === "goodbye2 world";
      expect(isWinner1 || isWinner2).toBe(true);
    });
  });
});
