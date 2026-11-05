import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createOwnerAwareErrorLogger } from "../../apps/api/src/owner-aware-logger.js";
import { GoogleApiClient } from "../../packages/connectors/src/google-api-client.js";
import { registerRouteEnablementGuard } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";
import {
  continueInRequestLogOwner,
  createDiagnosticLogDestination,
  rememberRequestLogOwner,
  runWithLogOwner,
  withCurrentLogOwner,
  type DiagnosticLogRow
} from "@moss/settings";
import { createSanitizingFormatters } from "@moss/shared";

// #3978 slice 2D: the owner scope must end with the request, and an unowned request must not
// inherit an outer scope.

const A = "00000000-0000-4000-8000-0000000000a1";

describe("owner scope lifetime", () => {
  it("gives an unowned request an empty scope even inside an owned one", () => {
    const seen: Array<Record<string, unknown>> = [];
    runWithLogOwner(A, () => {
      continueInRequestLogOwner({}, new EventEmitter(), () => {
        seen.push(withCurrentLogOwner({ k: 1 }));
      });
    });
    expect(seen).toEqual([{ k: 1 }]);
  });

  it("stops applying the owner once the response closes", async () => {
    const request = {};
    const response = new EventEmitter();
    rememberRequestLogOwner(request, A);
    let later: Promise<Record<string, unknown>> = Promise.resolve({});
    let now: Record<string, unknown> = {};
    continueInRequestLogOwner(request, response, () => {
      now = withCurrentLogOwner({});
      // Detached work started inside the scope and read after the response closes.
      later = new Promise((resolve) => setTimeout(() => resolve(withCurrentLogOwner({})), 20));
    });
    expect(now).toEqual({ actorUserId: A });
    response.emit("close");
    expect(await later).toEqual({});
  });

  it("carries no owner when the response closed before the scope was entered", async () => {
    const request = {};
    const response = Object.assign(new EventEmitter(), { closed: false });
    rememberRequestLogOwner(request, A);
    // Aborted during an earlier hook, so "close" fired before this hook registered a listener.
    response.closed = true;
    response.emit("close");
    let seen: Promise<Record<string, unknown>> = Promise.resolve({ unset: true });
    continueInRequestLogOwner(request, response, () => {
      seen = new Promise((resolve) => setTimeout(() => resolve(withCurrentLogOwner({})), 20));
    });
    expect(await seen).toEqual({});
  });

  it("stops applying after a bound function settles", async () => {
    let later: Promise<Record<string, unknown>> = Promise.resolve({});
    let during: Record<string, unknown> = {};
    await runWithLogOwner(A, async () => {
      await Promise.resolve();
      during = withCurrentLogOwner({});
      later = new Promise((resolve) => setTimeout(() => resolve(withCurrentLogOwner({})), 20));
    });
    expect(during).toEqual({ actorUserId: A });
    expect(await later).toEqual({});
  });

  it("does not stamp detached client work that outlives its request", async () => {
    const rows: DiagnosticLogRow[] = [];
    const stream = createDiagnosticLogDestination({
      process: "api",
      target: { write: () => true },
      sink: {
        enqueue: (r) => void rows.push(r),
        flush: async () => {},
        close: async () => {},
        stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
      }
    });
    const server = Fastify({
      logger: {
        level: "info",
        base: { process: "api" },
        formatters: createSanitizingFormatters(),
        stream
      } as never
    });
    const client = new GoogleApiClient({
      logger: createOwnerAwareErrorLogger(server.log),
      fetchFn: (async () =>
        new Response(JSON.stringify({ calendars: {} }), { status: 200 })) as typeof fetch
    });
    const manifests = [
      { id: "demo", routes: [{ method: "GET", path: "/demo" }] }
    ] as unknown as MossModuleManifest[];
    registerRouteEnablementGuard(server, {
      manifests,
      resolveActiveModules: async () => manifests,
      resolveAccessContext: async () => ({ actorUserId: A, requestId: "r" })
    });
    let detached: Promise<unknown> = Promise.resolve();
    server.get("/demo", async () => {
      detached = new Promise((resolve) =>
        setTimeout(() => {
          client
            .freeBusy({ accessToken: "t", timeMin: "a", timeMax: "b" })
            .catch(() => undefined)
            .then(resolve);
        }, 50)
      );
      return { ok: true };
    });
    await server.inject({ url: "/demo" });
    await detached;
    await server.close();
    const detachedRows = rows.filter((r) => r.message.includes("freeBusy omitted"));
    expect(detachedRows).toHaveLength(1);
    expect(detachedRows[0]!.ownerUserId).toBeNull();
  });
});
