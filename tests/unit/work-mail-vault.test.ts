import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiSecretCipher } from "@moss/ai";
import { ChatMemoryFactsRepository } from "@moss/memory";
import { PreferencesRepository } from "@moss/structured-state";
import {
  appendVaultFileBytes,
  readVaultFileBytes,
  VaultContextRunner,
  writeVaultFile,
  type VaultContext
} from "@moss/vault";
import { createWorkMailPorts } from "../../packages/module-registry/src/work-mail-ports.js";
import { isPrivateWorkMailNote } from "../../packages/connectors/src/work-mail/entry.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const access = { actorUserId: "00000000-0000-4000-8000-000000000001" };
let root: string;
let vault: VaultContextRunner;
let ctx: VaultContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "work-mail-vault-"));
  vault = new VaultContextRunner(root);
  ctx = await vault.withVaultContext(access, async (value) => value);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fixture(linkedRoot: string | null = null) {
  vi.spyOn(PreferencesRepository.prototype, "get").mockResolvedValue(linkedRoot);
  const ports = createWorkMailPorts({
    vault,
    allowedRoots: [root],
    retrieval: { retrieve: async () => [] },
    ai: {
      cipher: createAiSecretCipher(),
      repository: {
        resolveModelForService: async () => {
          throw new Error("unused");
        },
        selectProviderWithCredential: async () => undefined
      }
    }
  });
  return { ports, db: makeRecordingDb().scoped };
}
describe("work mail vault boundaries", () => {
  it("preserves arbitrary original bytes, refuses stale snapshots and serializes competing appends", async () => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff]);
    expect(await appendVaultFileBytes(ctx, "original.md", null, original)).toBe("written");
    const results = await Promise.all([
      appendVaultFileBytes(ctx, "original.md", original, Buffer.from(" one")),
      appendVaultFileBytes(ctx, "original.md", original, Buffer.from(" two"))
    ]);
    expect(results).toEqual(["written", "changed"]);
    expect(await readVaultFileBytes(ctx, "original.md")).toEqual(
      Buffer.concat([original, Buffer.from(" one")])
    );
  });
  it("uses private and linked defaults, refuses unavailable roots, private destinations and escapes", async () => {
    const { ports, db } = fixture();
    expect(await ports.notes.append(db, access, "default", "First")).toBe("written");
    expect((await readVaultFileBytes(ctx, "Work mail notes.md")).toString()).toBe("First");
    await writeVaultFile(ctx, "secret.md", "---\nprivate: true\n---\nSecret");
    expect(await ports.notes.append(db, access, "secret.md", "bad")).toBe("private");
    expect(await ports.notes.append(db, access, "../escape.md", "bad")).toBe("unavailable");
    await symlink(tmpdir(), join(ctx.vaultRoot, "outside"));
    expect(await ports.notes.append(db, access, "outside/out.md", "bad")).toBe("unavailable");
    vi.mocked(PreferencesRepository.prototype.get).mockResolvedValue(root);
    expect(await ports.notes.append(db, access, "default", "Linked")).toBe("written");
    await vault.withVaultContextAt(access, root, [root], async (linked) => {
      expect((await readVaultFileBytes(linked, "Work mail notes.md")).toString()).toBe("Linked");
    });
    vi.mocked(PreferencesRepository.prototype.get).mockResolvedValue(join(root, "missing"));
    expect(await ports.notes.append(db, access, "default", "bad")).toBe("unavailable");
  });
  it("filters private and stale candidates before exposing their contents", async () => {
    const { db } = fixture();
    await writeVaultFile(ctx, "secret.md", "---\nprivate: true\n---\nHidden");
    await writeVaultFile(ctx, "project.md", "Fresh public text");
    const ports = createWorkMailPorts({
      vault,
      retrieval: {
        retrieve: async () =>
          ["secret.md", "project.md"].map((sourcePath) => ({
            id: sourcePath,
            sourcePath,
            lineStart: 1,
            lineEnd: 1,
            text: "Stale indexed text",
            similarity: 1,
            updatedAt: new Date("2026-10-26T00:00:00Z")
          }))
      },
      ai: {
        cipher: createAiSecretCipher(),
        repository: {
          resolveModelForService: async () => {
            throw new Error("unused");
          },
          selectProviderWithCredential: async () => undefined
        }
      }
    });
    expect(await ports.notes.candidates(db, access, "project", 5)).toEqual([
      { index: 0, path: "project.md", title: "project", excerpt: "Fresh public text" }
    ]);
    const facts = vi
      .spyOn(ChatMemoryFactsRepository.prototype, "listActiveFacts")
      .mockResolvedValue([]);
    expect(await ports.preferences.list(db, access.actorUserId)).toEqual([]);
    expect(facts).toHaveBeenCalledWith(db, access.actorUserId);
  });
  it.each([
    "private: &flag true",
    "flag: &flag true\nprivate: *flag",
    '{"private": true}',
    "? private\n: true",
    "private: !!bool true",
    "private: !custom true",
    "private: true\nprivate: false",
    "private: [",
    "<<: {private: true}"
  ])("refuses private or ambiguous YAML: %s", (yaml) => {
    expect(isPrivateWorkMailNote(`---\n${yaml}\n---\nBody`)).toBe(true);
  });
});
