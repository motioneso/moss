// tests/unit/external-module-trust-gate-logging.test.ts
//
// A trust-gate refusal on the queue path must be LOUD in two independent places: a `warn`
// log line, and a rejected promise carrying the reason.
//
// It used to be neither. The refusal resolved the caller to `undefined`, and a pg-boss job
// that resolves to `undefined` is recorded `completed` with NULL output in milliseconds —
// from outside the worker, indistinguishable from "the handler ran and had nothing to do",
// with nothing to grep. On 2026-07-29 that cost hours: leaked worker processes holding stale
// discovery refused three real jobs `hash-mismatch`, and the job rows said `completed`.
//
// So these tests pin BOTH halves. The log line is asserted per reason because which field
// differs is the whole diagnosis (see each case). The rejection is asserted alongside it
// because a log file is not a durable record — the one from that incident was truncated by a
// restart script mid-investigation, and the reason survived only on the thrown error.
import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Job } from "pg-boss";

import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import type { ExternalModuleJobPayload } from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";
import type { ModuleCredentialCipher } from "@moss/settings";

import { createExternalModuleJobHandler } from "../../apps/worker/src/external-module-job-handler.js";

const OWNER = "00000000-0000-4000-8000-00000000000a";
const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;

/** A chainable stand-in for the single status/hash lookup the gate runs. */
function fakeWorkerDb(
  row: { status: string; manifest_hash: string; package_hash: string } | undefined
): Kysely<MossDatabase> {
  const builder = {
    selectFrom: () => builder,
    select: () => builder,
    where: () => builder,
    executeTakeFirst: async () => row
  };
  return builder as unknown as Kysely<MossDatabase>;
}

function discovery(): ExternalModuleDiscovery {
  return {
    id: "acme",
    manifestHash: MANIFEST_HASH,
    packageHash: PACKAGE_HASH,
    manifest: {}
  } as unknown as ExternalModuleDiscovery;
}

const queue: ExternalModuleQueueDeclaration = {
  name: "acme.crawl-run",
  handler: "crawl.run"
} as unknown as ExternalModuleQueueDeclaration;

function job(): Job<ExternalModuleJobPayload> {
  return {
    id: "job-1",
    data: {
      actorUserId: OWNER,
      moduleId: "acme",
      jobKind: "crawl.run",
      manifestHash: MANIFEST_HASH
    }
  } as unknown as Job<ExternalModuleJobPayload>;
}

/**
 * Builds a handler whose gate inputs can each be individually poisoned. Defaults are the
 * happy path, so every test below changes exactly one thing and the reason it logs is
 * unambiguous.
 */
function fixture(
  overrides: {
    row?: { status: string; manifest_hash: string; package_hash: string } | undefined;
    discovered?: boolean;
    activeUsers?: readonly string[];
  } = {}
) {
  const module = discovery();
  const warn = vi.fn();
  const invoke = vi.fn().mockResolvedValue("done");
  const handler = createExternalModuleJobHandler({
    module,
    queue,
    workerDb: fakeWorkerDb(
      "row" in overrides
        ? overrides.row
        : { status: "enabled", manifest_hash: MANIFEST_HASH, package_hash: PACKAGE_HASH }
    ),
    getDiscoveryById:
      overrides.discovered === false
        ? (_id: string) => undefined
        : (id: string) => (id === module.id ? module : undefined),
    listDiscoveredModuleIds: () => (overrides.discovered === false ? [] : [module.id]),
    dataContext: {
      withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
        fn({} as DataContextDb)
    } as unknown as DataContextRunner,
    cipher: {} as unknown as ModuleCredentialCipher,
    runtime: { invoke },
    listActiveUserIds: async () => overrides.activeUsers ?? [OWNER],
    logger: { warn }
  });
  return { handler, warn, invoke };
}

describe("external module trust-gate rejection logging", () => {
  it("logs the reason when the actor is not an active user of the module", async () => {
    const { handler, warn, invoke } = fixture({ activeUsers: [] });
    // Rejects rather than resolves: a refused job must land in pg-boss as `failed` with the
    // reason, never as a `completed` row with NULL output that reads exactly like success.
    await expect(handler(job())).rejects.toThrow(/declined: not-active/);
    expect(invoke).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "external_module.trust_gate_rejected",
      reason: "not-active",
      moduleId: "acme",
      jobKind: "crawl.run"
    });
  });

  it("logs the reason, and what WAS discovered, when the module is missing from discovery", async () => {
    // The discovered list is the useful half: an empty array says the staged package dir is
    // missing or unreadable, while a populated one without this id says the module alone
    // failed to stage.
    const { handler, warn } = fixture({ discovered: false });
    await expect(handler(job())).rejects.toThrow(/declined: not-discovered/);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      reason: "not-discovered",
      discovered: []
    });
  });

  it("logs the reason and the current status when the module is not enabled", async () => {
    const { handler, warn } = fixture({
      row: { status: "disabled", manifest_hash: MANIFEST_HASH, package_hash: PACKAGE_HASH }
    });
    await expect(handler(job())).rejects.toThrow(/declined: not-enabled/);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      reason: "not-enabled",
      status: "disabled"
    });
  });

  it("logs the reason with an absent status when there is no installation row at all", async () => {
    const { handler, warn } = fixture({ row: undefined });
    await expect(handler(job())).rejects.toThrow(/declined: not-enabled/);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      reason: "not-enabled",
      status: null
    });
  });

  it("logs BOTH hash pairs on a mismatch, so which one drifted is readable from the log", async () => {
    // Which hash moved is the whole diagnosis: manifest-only means a core change without a
    // re-enable, package means the staged bytes moved under a running worker.
    const stale = `sha256:${"c".repeat(64)}`;
    const { handler, warn } = fixture({
      row: { status: "enabled", manifest_hash: MANIFEST_HASH, package_hash: stale }
    });
    await expect(handler(job())).rejects.toThrow(/declined: hash-mismatch/);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      reason: "hash-mismatch",
      dbManifestHash: MANIFEST_HASH,
      discoveredManifestHash: MANIFEST_HASH,
      dbPackageHash: stale,
      discoveredPackageHash: PACKAGE_HASH
    });
  });

  it("stays silent on the happy path — a rejection log must mean a rejection", async () => {
    const { handler, warn, invoke } = fixture();
    await handler(job());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not require a logger — an unwired caller still refuses, with the reason on the error", async () => {
    // The dep is optional so existing callers compile unchanged. With no logger the thrown
    // reason is the ONLY surviving record of the refusal, which is why it carries the reason
    // string: the 2026-07-30 incident lost its log file to a restart script's truncation.
    const module = discovery();
    const handler = createExternalModuleJobHandler({
      module,
      queue,
      workerDb: fakeWorkerDb(undefined),
      getDiscoveryById: (id: string) => (id === module.id ? module : undefined),
      listDiscoveredModuleIds: () => [module.id],
      dataContext: {
        withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({} as DataContextDb)
      } as unknown as DataContextRunner,
      cipher: {} as unknown as ModuleCredentialCipher,
      runtime: { invoke: vi.fn() },
      listActiveUserIds: async () => [OWNER]
    });
    await expect(handler(job())).rejects.toThrow(/declined: not-enabled/);
  });
});
