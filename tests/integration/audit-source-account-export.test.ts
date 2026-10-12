import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { Job } from "@moss/jobs";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { PrivateNoteExportService } from "@moss/notes";
import { VaultContextRunner, writeVaultFile } from "@moss/vault";
import { fastify, type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerDataExportAsyncRoutes } from "../../packages/settings/src/data-export-async-routes.js";
import {
  handleExportBuildJob,
  type ExportBuildJobPayload
} from "../../packages/settings/src/data-export-jobs.js";
import { DataExportRepository } from "../../packages/settings/src/data-export-repository.js";
import type {
  ExportedMarkdownFile,
  VaultFilesExportManifest
} from "../../packages/settings/src/data-export-vault.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// This suite must run through scripts/run-gate.sh. It uses real owner-scoped DB reads, worker
// transitions, VaultContext file writes and actual archive download handler with a test-only
// access-context resolver. This is not live authentication proof.
describe("CORE11 real account archive includes owned Markdown originals (#3397)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let server: FastifyInstance;
  let root: string;
  let jobId: string;
  let generatedPath: string;
  const authored = "# Synthetic owned note\r\nOriginal café text.\r\n";
  const generated = "# Synthetic versioned meeting copy\n";

  beforeAll(async () => {
    await resetFoundationDatabase();
    root = await mkdtemp(join(tmpdir(), "moss-audit-source-integration-"));
    vi.stubEnv("MOSS_VAULT_ROOT", root);
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    appContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    const vaultRunner = new VaultContextRunner(root);
    await vaultRunner.withVaultContext(
      { actorUserId: ids.userA, requestId: "audit-source:seed-a" },
      async (ctx) => {
        await writeVaultFile(ctx, "welcome.md", authored);
        await writeVaultFile(ctx, "custom/nested.md", "# Nested owned original\n");
        await writeVaultFile(ctx, "exports/prior.md", "EXCLUDED EXPORT ARTIFACT");
      }
    );
    await vaultRunner.withVaultContext(
      { actorUserId: ids.userB, requestId: "audit-source:seed-b" },
      (ctx) => writeVaultFile(ctx, "foreign.md", "FOREIGN PRIVATE ORIGINAL")
    );
    const noteService = new PrivateNoteExportService(vaultRunner, {
      enqueue: async () => ({ status: "queued", jobId: "unused" })
    });
    const note = await noteService.createOrInspect(
      { actorUserId: ids.userA, requestId: "audit-source:generated" },
      { sourceId: "55555555-5555-4555-8555-555555555555", version: 1 },
      generated
    );
    generatedPath = note.noteReference;
    expect(note.status).toBe("written");

    const repository = new DataExportRepository();
    const job = await appContext.withDataContext(
      { actorUserId: ids.userA, requestId: "audit-source:create" },
      (ctx) => repository.createJob(ctx, ids.userA, "json")
    );
    jobId = job.id;
    await workerContext.withDataContext(
      { actorUserId: ids.userA, requestId: "audit-source:build" },
      (ctx) =>
        handleExportBuildJob(
          {
            data: { kind: "export.build", actorUserId: ids.userA, jobId }
          } as Job<ExportBuildJobPayload>,
          ctx,
          getBuiltInModuleManifests
        )
    );

    server = fastify();
    registerDataExportAsyncRoutes(server, {
      boss: null as never,
      dataContext: appContext,
      resolveAccessContext: async (request) => ({
        actorUserId: request.headers.authorization === "Bearer user-b" ? ids.userB : ids.userA,
        requestId: "audit-source:download"
      })
    });
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await appDb?.destroy();
    await workerDb?.destroy();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("returns a ready archive with verifiable original bytes and explicit file exclusions", async () => {
    const status = await server.inject({ method: "GET", url: `/api/me/export/status/${jobId}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ jobId, status: "ready" });
    const download = await server.inject({
      method: "GET",
      url: `/api/me/export/download/${jobId}`
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/json");
    const archive = download.json() as {
      format: string;
      userId: string;
      sections: { vault_files: ExportedMarkdownFile[] };
      manifest: { vaultFiles: VaultFilesExportManifest };
    };
    expect(archive.format).toBe("jarvis-archive/v1");
    expect(archive.userId).toBe(ids.userA);
    expect(archive.sections.vault_files.map((file) => file.path)).toEqual([
      "custom/nested.md",
      generatedPath,
      "welcome.md"
    ]);
    for (const [path, content] of [
      ["welcome.md", authored],
      [generatedPath, generated]
    ]) {
      const file = archive.sections.vault_files.find((item) => item.path === path)!;
      const bytes = Buffer.from(content!, "utf8");
      expect(file.encoding).toBe("base64");
      expect(Buffer.from(file.content, "base64")).toEqual(bytes);
      expect(file.byteLength).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(archive.manifest.vaultFiles).toMatchObject({
      status: "complete",
      complete: true,
      eligibleFileCount: 3,
      includedCount: 3,
      excludedFiles: [{ path: "exports/prior.md", reason: "non-note-storage" }]
    });
    expect(download.payload).not.toContain("FOREIGN PRIVATE ORIGINAL");
    expect(download.payload).not.toContain("EXCLUDED EXPORT ARTIFACT");
  });

  it("does not let another owner poll or download the archive", async () => {
    for (const endpoint of ["status", "download"]) {
      const response = await server.inject({
        method: "GET",
        url: `/api/me/export/${endpoint}/${jobId}`,
        headers: { authorization: "Bearer user-b" }
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
