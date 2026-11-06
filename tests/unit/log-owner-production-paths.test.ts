import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createOwnerAwareErrorLogger } from "../../apps/api/src/owner-aware-logger.js";
import { GoogleApiClient } from "../../packages/connectors/src/google-api-client.js";
import { registerRouteEnablementGuard } from "@moss/module-registry";
import type * as ConnectorsRepositoryModule from "../../packages/connectors/src/repository.js";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  createDiagnosticLogDestination,
  type DiagnosticLogRow,
  type DiagnosticLogSink
} from "@moss/settings";
import { createSanitizingFormatters } from "@moss/shared";

// #3978 slice 2D: owners reach the stored record from the real production paths. The API path is
// a real Fastify route behind the real route guard calling a real Google client. The worker path
// is the real registered Google sync worker. Nothing here calls a binding helper directly.

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";

function capture(processName: "api" | "worker") {
  const rows: DiagnosticLogRow[] = [];
  const sink: DiagnosticLogSink = {
    enqueue: (r) => void rows.push(r),
    flush: async () => {},
    close: async () => {},
    stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
  };
  const stream = createDiagnosticLogDestination({
    process: processName,
    target: { write: () => true },
    sink
  });
  return { rows, stream };
}

const manifests = [
  { id: "demo", routes: [{ method: "GET", path: "/demo" }] }
] as unknown as MossModuleManifest[];

describe("API: shared Google client logs the request owner", () => {
  it("stores each concurrent request's own user as owner", async () => {
    const { rows, stream } = capture("api");
    const server = Fastify({
      logger: {
        level: "info",
        base: { process: "api" },
        formatters: createSanitizingFormatters(),
        stream
      } as never
    });
    // The one shared client, built the way the composition root builds it.
    const client = new GoogleApiClient({
      logger: createOwnerAwareErrorLogger(server.log),
      fetchFn: (async () =>
        new Response(JSON.stringify({ calendars: {} }), { status: 200 })) as typeof fetch
    });
    registerRouteEnablementGuard(server, {
      manifests,
      resolveActiveModules: async () => manifests,
      resolveAccessContext: async (request) => ({
        actorUserId: String(request.headers["x-user"]),
        requestId: "r"
      })
    });
    server.get("/demo", async (request) => {
      // Yield so the two requests interleave before the client logs.
      await new Promise((r) => setTimeout(r, request.headers["x-user"] === A ? 20 : 5));
      await client
        .freeBusy({ accessToken: "t", timeMin: "a", timeMax: "b" })
        .catch(() => undefined);
      return { ok: true };
    });
    await Promise.all([
      server.inject({ url: "/demo", headers: { "x-user": A } }),
      server.inject({ url: "/demo", headers: { "x-user": B } })
    ]);
    await server.close();

    const clientRows = rows.filter((r) => r.message.includes("freeBusy omitted"));
    expect(clientRows.map((r) => r.ownerUserId).sort()).toEqual([A, B]);
  });
});

const hoisted = vi.hoisted(() => ({
  handlers: [] as Array<(jobs: unknown[]) => Promise<unknown>>
}));

vi.mock("@moss/jobs", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@moss/jobs")),
  hasInFlightJob: async () => false
}));

vi.mock("../../packages/connectors/src/repository.js", async () => {
  const mod = await vi.importActual<typeof ConnectorsRepositoryModule>(
    "../../packages/connectors/src/repository.js"
  );
  class FakeRepository extends mod.ConnectorsRepository {
    override async getActiveGoogleAccountSecret() {
      await new Promise((r) => setTimeout(r, 5));
      // Not a real ciphertext, so the real decrypt step fails and the real warning is logged.
      return { id: "acct", encryptedSecret: { v: 1, iv: "x", tag: "x", data: "x" } as never };
    }
  }
  return { ...mod, ConnectorsRepository: FakeRepository };
});

describe("worker: registered Google sync logs the job owner", () => {
  it("stores each concurrent job's own user as owner", async () => {
    const { registerConnectorsJobWorkers } =
      await import("../../packages/connectors/src/sync-jobs.js");
    const { rows, stream } = capture("worker");
    const logger = Fastify({
      logger: {
        level: "info",
        base: { process: "worker" },
        formatters: createSanitizingFormatters(),
        stream
      } as never
    }).log;
    hoisted.handlers.length = 0;
    const boss = {
      work: async (_q: string, _o: unknown, handler: (jobs: unknown[]) => Promise<unknown>) => {
        hoisted.handlers.push(handler);
        return "w";
      }
    };
    await registerConnectorsJobWorkers(
      boss as never,
      {
        dataContext: {
          withDataContext: async (_c: unknown, fn: (db: unknown) => unknown) => fn({})
        },
        rootDb: {} as never,
        taskPort: {} as never,
        logger
      } as never
    );
    const rootHandler = hoisted.handlers[0]!;
    const job = (id: string, owner: string) => ({
      id,
      data: {
        kind: "google-sync",
        actorUserId: owner,
        idempotencyKey: id,
        trigger: "manual"
      }
    });
    await Promise.all([
      rootHandler([job("j1", A)]).catch(() => undefined),
      rootHandler([job("j2", B)]).catch(() => undefined)
    ]);

    const warnings = rows.filter((r) => r.message === "google-sync stored connection invalid");
    expect(warnings.map((r) => r.ownerUserId).sort()).toEqual([A, B]);
    expect(warnings.every((r) => !("actorScoped" in r.context))).toBe(true);
  });
});
