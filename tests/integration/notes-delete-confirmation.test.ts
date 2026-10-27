import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, DataContextRunner } from "@moss/db";
import { NOTES_SOURCE_PREFERENCE_KEY } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { notesModuleManifest } from "../../packages/notes/src/manifest.js";
import { admissionFixture } from "../unit/helpers/gateway-admission-fixture.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const runner = new DataContextRunner(db);
beforeAll(resetFoundationDatabase);
afterAll(() => db.destroy());
const content = "A note that must survive a rejected deletion.";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-note-delete-confirmation-"));
  vi.stubEnv("MOSS_NOTES_ROOTS", root);
  vi.stubEnv("JARVIS_NOTES_ROOTS", root);
  await runner.withDataContext({ actorUserId: ids.userA, requestId: "seed" }, (scopedDb) =>
    new PreferencesRepository().upsert(scopedDb, NOTES_SOURCE_PREFERENCE_KEY, root)
  );
  await writeFile(join(root, "Keep.md"), content);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.each(["trusted_auto", "auto-approve", "both"] as const)(
  "permanent note deletion with %s enabled",
  (mode) => {
    it.each(["rejected", "confirmed"] as const)(
      "waits for the exact card, then handles %s once",
      async (decision) => {
        const declared = notesModuleManifest.assistantTools.find(
          (tool) => tool.name === "notes.delete"
        )!;
        // Real scoped persistence, manifest, presentation, and deletion; action notifications stay in memory.
        const execute = vi.fn(declared.execute);
        const tool = { ...declared, isExternal: false, execute };
        const family = notesModuleManifest.assistantActionFamilies.find(
          (entry) => entry.id === "note_changes"
        )!;
        const enqueue = vi.fn(async () => null);
        const h = admissionFixture([tool], {
          actorUserId: ids.userA,
          deps: {
            resolveActiveModules: async () => [{ ...notesModuleManifest, assistantTools: [tool] }],
            runner,
            toolServices: { notesSync: { enqueue } },
            actionPolicy: () => ({
              getFamilyTier: async () =>
                mode !== "auto-approve" ? "trusted_auto" : "ask_each_time",
              getFamilyManifest: async (moduleId, familyId) => {
                expect([moduleId, familyId]).toEqual(["notes", "note_changes"]);
                return family;
              }
            }),
            yoloMode: async () => mode !== "trusted_auto",
            confirmTimeoutMs: 2_000
          }
        });
        expect(h.state.tainted).toBe(false);
        const input = { path: "Keep.md" };
        const pending = h.gateway.callTool(h.token, "notes.delete", input);
        try {
          await vi.waitFor(
            () => {
              expect(execute).not.toHaveBeenCalled();
              expect(h.confirmations.isAwaiting("action-1")).toBe(true);
            },
            { timeout: 500, interval: 5 }
          );
          expect(h.createPending).toHaveBeenCalledTimes(1);
          expect(execute).not.toHaveBeenCalled();
          expect(enqueue).not.toHaveBeenCalled();
          expect(h.runAutomatic).not.toHaveBeenCalled();
          expect(await readFile(join(root, "Keep.md"), "utf8")).toBe(content);
          expect(h.records).toMatchObject([
            {
              kind: "action_request",
              outcomeTitle: "Delete note",
              details: {
                presentation: "human",
                approvalKind: "note_delete",
                target: "Keep.md",
                fields: [
                  {
                    label: "Deletion",
                    value: "Permanently delete this note. There is no trash or undo."
                  }
                ]
              }
            }
          ]);
          h.confirmations.resolve("action-1", decision);
          const result = await pending;
          expect(h.confirmations.isAwaiting("action-1")).toBe(false);
          if (decision === "rejected") {
            expect(result).toMatchObject({ ok: false, denied: true });
            expect(execute).not.toHaveBeenCalled();
            expect(enqueue).not.toHaveBeenCalled();
            expect(await readFile(join(root, "Keep.md"), "utf8")).toBe(content);
          } else {
            expect(result.ok).toBe(true);
            expect(execute).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ db: expect.anything() }),
              { path: "Keep.md" },
              expect.objectContaining({ actorUserId: ids.userA }),
              { notesSync: { enqueue } }
            );
            expect(enqueue).toHaveBeenCalledTimes(1);
            await expect(access(join(root, "Keep.md"))).rejects.toMatchObject({ code: "ENOENT" });
            h.confirmations.resolve("action-1", "confirmed");
            expect(execute).toHaveBeenCalledTimes(1);
          }
          expect(input).toEqual({ path: "Keep.md" });
        } finally {
          h.confirmations.resolve("action-1", "cancelled");
          await pending;
        }
      }
    );
  }
);
