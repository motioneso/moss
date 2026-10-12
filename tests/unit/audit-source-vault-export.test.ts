import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VaultContextRunner,
  readVaultFile,
  writeVaultFile,
  writeVaultFileBytes
} from "@moss/vault";
import type * as database from "@moss/db";
import type { Job } from "@moss/jobs";
import * as vault from "@moss/vault";

import { DataExportRepository } from "../../packages/settings/src/data-export-repository.js";
import {
  handleExportBuildJob,
  type ExportBuildJobPayload
} from "../../packages/settings/src/data-export-jobs.js";

const mocks = vi.hoisted(() => ({ exportUserData: vi.fn(), destroy: vi.fn() }));
vi.mock("../../packages/settings/src/data-export.js", () => ({
  exportUserData: mocks.exportUserData
}));
vi.mock("@moss/db", async (importOriginal) => ({
  ...(await importOriginal<typeof database>()),
  createDatabase: () => ({ destroy: mocks.destroy })
}));

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const notePath = "notes/generated/44444444-4444-4444-8444-444444444444/v1.md";
const access = { actorUserId: owner, requestId: "audit-source-test" };
let root: string;
let runner: VaultContextRunner;
let complete: ReturnType<typeof vi.spyOn>;

interface Archive {
  sections: {
    vault_files: Array<{
      path: string;
      encoding: string;
      content: string;
      byteLength: number;
      sha256: string;
    }>;
  };
  manifest: {
    vaultFiles: {
      scope: string;
      status: "complete" | "partial" | "unavailable";
      complete: boolean;
      includedCount: number;
      excludedFiles: Array<{ path: string; reason: string }>;
      limitations: string[];
    };
  };
}
async function build(): Promise<Archive> {
  const job = {
    data: { kind: "export.build", actorUserId: owner, jobId }
  } as Job<ExportBuildJobPayload>;
  await handleExportBuildJob(job, null as never, () => []);
  expect(complete).toHaveBeenCalledOnce();
  return runner.withVaultContext(
    access,
    async (ctx) => JSON.parse(await readVaultFile(ctx, `exports/${jobId}.json`)) as Archive
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-audit-source-"));
  runner = new VaultContextRunner(root);
  vi.stubEnv("MOSS_VAULT_ROOT", root);
  mocks.exportUserData.mockResolvedValue({
    exportedAt: "2026-10-11T00:00:00.000Z",
    userId: owner,
    tables: { users: [] }
  });
  mocks.destroy.mockResolvedValue(undefined);
  vi.spyOn(DataExportRepository.prototype, "workerUpdateJobStatus").mockResolvedValue(undefined);
  complete = vi
    .spyOn(DataExportRepository.prototype, "workerCompleteJob")
    .mockResolvedValue(undefined);
  vi.spyOn(DataExportRepository.prototype, "workerFailJob").mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("CORE11 owned Markdown originals in the assembled account archive", () => {
  it("includes root, nested and generated originals with exact bytes and verifiable accounting", async () => {
    const original = Buffer.from("\ufeff# Synthetic note\r\nCafé 🍃\r\n", "utf8");
    await runner.withVaultContext(access, async (ctx) => {
      await writeVaultFileBytes(ctx, "welcome.md", original);
      await writeVaultFile(ctx, "custom/meeting.md", "# Nested original\n");
      await writeVaultFile(ctx, notePath, "# Versioned owned copy\n");
    });
    const archive = await build();
    expect(archive.sections.vault_files.map((file) => file.path)).toEqual([
      "custom/meeting.md",
      notePath,
      "welcome.md"
    ]);
    const note = archive.sections.vault_files.find((file) => file.path === "welcome.md")!;
    expect(note.encoding).toBe("base64");
    expect(Buffer.from(note.content, "base64")).toEqual(original);
    expect(note.byteLength).toBe(original.byteLength);
    expect(note.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(archive.manifest.vaultFiles).toMatchObject({
      scope: "owned-markdown",
      status: "complete",
      complete: true,
      includedCount: 3,
      excludedFiles: []
    });
  });

  it("accounts for non-note storage and unsupported extensions without importing foreign or symlinked files", async () => {
    await runner.withVaultContext({ ...access, actorUserId: other }, async (ctx) => {
      await writeVaultFile(ctx, "foreign.md", "FOREIGN ORIGINAL MUST NOT BE EXPORTED");
    });
    await runner.withVaultContext(access, async (ctx) => {
      await writeVaultFile(ctx, "welcome.md", "owned note");
      for (const file of [
        "exports/old.md",
        "attachments/copied.md",
        "workflows/result.md",
        "sports/photos/sidecar.md",
        "readme.txt",
        "upper.MD"
      ]) {
        await writeVaultFile(ctx, file, "EXCLUDED FILE CONTENT");
      }
      await symlink(join(root, other, "foreign.md"), join(ctx.vaultRoot, "linked.md"));
      await symlink(join(root, other), join(ctx.vaultRoot, "foreign-folder"));
    });
    const archive = await build();
    expect(archive.sections.vault_files.map((file) => file.path)).toEqual(["welcome.md"]);
    expect(archive.manifest.vaultFiles.excludedFiles).toEqual([
      { path: "attachments/copied.md", reason: "non-note-storage" },
      { path: "exports/old.md", reason: "non-note-storage" },
      { path: "readme.txt", reason: "not-markdown" },
      { path: "sports/photos/sidecar.md", reason: "non-note-storage" },
      { path: "upper.MD", reason: "not-markdown" },
      { path: "workflows/result.md", reason: "non-note-storage" }
    ]);
    expect(JSON.stringify(archive)).not.toContain("FOREIGN ORIGINAL");
    expect(JSON.stringify(archive)).not.toContain("EXCLUDED FILE CONTENT");
    expect(archive.manifest.vaultFiles.limitations.join(" ")).toMatch(/symbolic links.*not/i);
    expect(archive.manifest.vaultFiles.limitations.join(" ")).toMatch(/linked.*not/i);
  });

  it("returns explicit empty accounting for a new owner vault", async () => {
    const archive = await build();
    expect(archive.sections.vault_files).toEqual([]);
    expect(archive.manifest.vaultFiles).toMatchObject({
      status: "complete",
      complete: true,
      includedCount: 0
    });
  });

  it("does not silently truncate a readable Markdown original", async () => {
    const original = Buffer.alloc(600_000, 97);
    await runner.withVaultContext(access, (ctx) => writeVaultFileBytes(ctx, "large.md", original));
    const archive = await build();
    const note = archive.sections.vault_files[0]!;
    expect(note.byteLength).toBe(original.byteLength);
    expect(Buffer.from(note.content, "base64")).toEqual(original);
  });

  it("marks a partial archive and accounts for unreadable eligible files without raw error details", async () => {
    await runner.withVaultContext(access, async (ctx) => {
      await writeVaultFile(ctx, "available.md", "available original");
      await writeVaultFile(ctx, "unreadable.md", "not readable now");
    });
    const originalRead = vault.readVaultFileBytes;
    vi.spyOn(vault, "readVaultFileBytes").mockImplementation((ctx, path) =>
      path === "unreadable.md"
        ? Promise.reject(new Error("PRIVATE INTERNAL ERROR DETAIL"))
        : originalRead(ctx, path)
    );
    const archive = await build();
    expect(archive.sections.vault_files.map((file) => file.path)).toEqual(["available.md"]);
    expect(archive.manifest.vaultFiles).toMatchObject({
      status: "partial",
      complete: false,
      eligibleFileCount: 2,
      includedCount: 1,
      excludedFiles: [{ path: "unreadable.md", reason: "read-failed" }]
    });
    expect(JSON.stringify(archive)).not.toContain("PRIVATE INTERNAL ERROR DETAIL");
  });

  it("declares the entire note section unavailable if its private vault cannot be listed", async () => {
    vi.spyOn(vault, "listVaultFilesRecursive").mockRejectedValueOnce(
      new Error("Synthetic vault listing failure")
    );
    const archive = await build();
    expect(archive.sections.vault_files).toEqual([]);
    expect(archive.manifest.vaultFiles).toMatchObject({
      status: "unavailable",
      complete: false,
      includedCount: 0,
      eligibleFileCount: null
    });
    expect(archive.manifest.vaultFiles.limitations.join(" ")).toContain("couldn't be read");
  });
});
