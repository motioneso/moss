import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations,
  assertRouteCoverage,
  type BuiltInRouteDependencies,
  type RegisteredRoute
} from "@moss/module-registry";

// Importing the actual composition root runs its compatibility gate. A default-disabled
// built-in prevents API/worker startup because this repository has deny-only enablement.
describe("meetings composition", () => {
  it("boots the real registry with a compatible optional draft module", () => {
    const meeting = getBuiltInModuleManifests().find((manifest) => manifest.id === "meetings");
    expect(meeting?.availability).toEqual({
      defaultEnabled: true,
      required: false,
      supportsUserDisable: true
    });
    expect(meeting?.database?.ownedTables).toEqual([
      "app.meeting_records",
      "app.meeting_note_writes",
      "app.meeting_transcript_batches",
      "app.meeting_output_requests",
      "app.meeting_output_artifacts",
      "app.meeting_action_candidates",
      "app.meeting_export_receipts",
      "app.meeting_export_requests"
    ]);
    expect(meeting?.navigation).toEqual([
      expect.objectContaining({
        id: "meetings",
        path: "/meetings",
        icon: "mic",
        permissionId: "meetings.read"
      })
    ]);
    expect(meeting?.routes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/meetings/records/:id/exports",
      "POST /api/meetings/records/:id/exports",
      "GET /api/meetings/records/:id/outputs",
      "GET /api/meetings/records/:id/outputs/:version",
      "POST /api/meetings/records/:id/outputs",
      "PUT /api/meetings/records/:id/outputs",
      "POST /api/meetings/records/:id/actions/:candidateId/review",
      "POST /api/meetings/records/:id/transcript",
      "GET /api/meetings/records/:id/transcript",
      "GET /api/meetings/records/:id/transcript/evidence",
      "GET /api/meetings/preferences",
      "PUT /api/meetings/preferences",
      "DELETE /api/meetings/records/:id",
      "GET /api/meetings/records",
      "GET /api/meetings/records/:id",
      "POST /api/meetings/records",
      "PUT /api/meetings/records/:id/notes"
    ]);
    expect(meeting?.features?.map((feature) => feature.id)).toEqual([
      "meetings.unsaved_changes",
      "meetings.referenced_evidence",
      "meetings.private_exports",
      "meetings.grounded_outputs",
      "meetings.reviewed_tasks",
      "meetings.questions",
      "meetings.transcript_storage",
      "meetings.transcript_review",
      "meetings.capture_default",
      "meetings.notes_recovery",
      "meetings.delete_draft",
      "meetings.draft_records"
    ]);
  });
});

// Exercise the composition root's real registrar, including every nested registrar, rather
// than reproducing its route list. No route handlers, DB, network or vault I/O are executed.
describe("meetings registered route coverage", () => {
  it("claims every actual route and declares no unregistered route", async () => {
    const app = Fastify({ logger: false });
    const registered: RegisteredRoute[] = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push({ method, url: route.url });
    });
    const registration = getBuiltInModuleRegistrations().find(
      (module) => module.manifest.id === "meetings"
    )!;
    const unused = () => {
      throw new Error("Route coverage must not execute runtime dependencies");
    };
    try {
      registration.registerRoutes!(app, {
        dataContext: { withDataContext: unused },
        resolveAccessContext: unused,
        resolveActiveModules: unused,
        boss: {}
      } as unknown as BuiltInRouteDependencies);
      await app.ready();
      expect(registered.length).toBeGreaterThan(0);
      expect(() =>
        assertRouteCoverage({
          registered,
          manifests: [registration.manifest],
          platformAllowlist: new Set()
        })
      ).not.toThrow();
    } finally {
      await app.close();
    }
  });
});
