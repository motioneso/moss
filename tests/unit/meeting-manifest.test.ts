import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { CORE_APP_SCREENS, CORE_APP_SETTINGS } from "@moss/shared";
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
  it("keeps single-link approval consistent with the newer minimal meeting surfaces", () => {
    const meeting = getBuiltInModuleManifests().find((item) => item.id === "meetings")!;
    const native = meeting.features!.find((item) => item.id === "meetings.native_capture")!;
    const profile = CORE_APP_SETTINGS.find((item) => item.id === "profile")!.description;
    const link = CORE_APP_SCREENS.find((item) => item.id === "link-trail-marker")!.description;
    expect(meeting.navigation![0]!.description).toContain("authorized by initial linking");
    expect(native.description).toContain("nav dot");
    expect(native.remediations![0]!.description).toContain("relink through Trail Marker");
    expect(JSON.stringify(native)).not.toMatch(/one-time recording|recording upgrade/);
    expect(profile).toContain("single initial linking approval");
    expect(profile).toContain("Summarize automatically after Stop (on by default)");
    expect(profile).toContain("existing exact source choices stay in effect");
    expect(profile).toContain("Meetings navigation dot and top-bar duration");
    expect(profile).not.toMatch(/one-time connection upgrade|persistent recording strip/);
    expect(link).toContain("Record meetings when you choose Start");
  });

  it("bounds the echo experiment and describes same-mic fallback in plain words", () => {
    const meeting = getBuiltInModuleManifests().find((item) => item.id === "meetings")!;
    const echo = meeting.features!.find((item) => item.id === "meetings.speaker_echo_control")!;
    expect(echo.description).toContain("echo control checked on built-in Mac speakers");
    expect(echo.description).toContain("Headsets/Bluetooth, Zoom sharing the mic");
    expect(echo.description).toContain("fallback on Macs rejecting setup are unchecked");
    expect(echo.description).toContain("same mic after cleanup");
    expect(echo.description).toContain("route changes need Resume");
    expect(echo.description).not.toContain("Real-speaker live validation pending");
    expect(echo.description.length).toBeLessThanOrEqual(240);
  });

  it("describes bounded same-source recovery and visible interruption remediation", () => {
    const meeting = getBuiltInModuleManifests().find((item) => item.id === "meetings")!;
    const recovery = meeting.features!.find(
      (item) => item.id === "meetings.native_source_recovery"
    )!;
    expect(recovery.description).toContain("Recovering audio…");
    expect(recovery.description).toContain("same sources up to 8 times per recording");
    expect(recovery.description).toContain("macOS may show its own permission dialog");
    expect(recovery.description).toContain("Pause and Stop cancel recovery");
    expect(recovery.description).toContain("Repeated interruptions need Resume");
    expect(recovery.description).toContain("missed audio is marked as a gap");
    expect(recovery.remediations![0]!.description).toContain("restores a hidden recording pill");
    expect(recovery.remediations![0]!.description).toContain("before Resume");
    expect(JSON.stringify(recovery)).not.toMatch(
      /Both tracks retain gaps|authority is not renewed/
    );
    for (const feature of meeting.features!) {
      expect(feature.description.length, feature.id).toBeLessThanOrEqual(240);
      for (const remediation of feature.remediations ?? [])
        expect(remediation.description.length, remediation.id).toBeLessThanOrEqual(240);
      for (const error of feature.errors ?? [])
        expect(error.description.length, error.code).toBeLessThanOrEqual(240);
    }
  });

  it("describes the actual passage exit, removable chat context and automatic title", () => {
    const features = getBuiltInModuleManifests().find((item) => item.id === "meetings")!.features!;
    const description = (id: string) => features.find((item) => item.id === id)!.description;
    expect(description("meetings.referenced_evidence")).toContain("Meetings to return to the list");
    expect(description("meetings.referenced_evidence")).not.toContain("Close evidence");
    const questions = features.find((item) => item.id === "meetings.questions")!;
    expect(questions.description).toBe(
      "Chat attaches the open meeting’s notes and transcript; its chip announces the title. API-key only, no actions. Remove About this meeting for ordinary subscription chat. Admin pins and locked defaults apply."
    );
    expect(questions.errors).toEqual([
      {
        code: "meeting_chat_unsupported",
        class: "prerequisite",
        remediationRef: "meetings.remove_chat_context",
        description:
          "Selected-meeting questions need an API-key chat model. Remove the About this meeting chip to continue ordinary chat with your subscription model."
      }
    ]);
    expect(questions.remediations).toEqual([
      {
        id: "meetings.remove_chat_context",
        path: "/meetings",
        description:
          "Remove the About this meeting chip in the chat drawer to continue ordinary subscription chat, or choose an API-key chat model for meeting questions."
      }
    ]);
    expect(questions.description).not.toContain("Ask Moss");
    expect(description("meetings.automatic_summary")).not.toContain("summarizeOnStop");
    expect(description("meetings.draft_records")).toContain(
      "Untitled meeting has the same title in its page, list and chat chip."
    );
    expect(description("meetings.automatic_summary")).toBe(
      "Automatic summaries default on and use your default model without fallback, including supported Claude. Turn off Summarize automatically after Stop in Settings → Meetings. Only these rename Untitled meeting; Rewrite summary stays available."
    );
  });

  it("explains export and history failures, including the Notes prerequisite", () => {
    const meeting = getBuiltInModuleManifests().find((manifest) => manifest.id === "meetings")!;
    const exports = meeting.features!.find((feature) => feature.id === "meetings.private_exports")!;
    expect(exports.description).toContain("Notes module");
    expect(exports.errors?.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "meeting_export_invalid_input",
        "meeting_export_unavailable",
        "meeting_export_content_conflict",
        "meeting_export_request_conflict"
      ])
    );
    expect(exports.remediations).toContainEqual(
      expect.objectContaining({ path: "/settings?section=modules" })
    );
    expect(
      meeting.features!.find((feature) => feature.id === "meetings.history")?.errors
    ).toContainEqual(expect.objectContaining({ code: "meeting_history_access_denied" }));
  });

  it("boots the real registry with a compatible optional meeting module", () => {
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
      "app.meeting_history_segments",
      "app.meeting_output_requests",
      "app.meeting_output_artifacts",
      "app.meeting_action_candidates",
      "app.meeting_export_receipts",
      "app.meeting_export_requests",
      "app.meeting_capture_links",
      "app.meeting_capture_grants",
      "app.meeting_capture_receipts",
      "app.meeting_capture_connections",
      "app.meeting_capture_start_cancellations",
      "app.meeting_stop_summaries",
      "app.meeting_capture_start_limits"
    ]);
    const chat = getBuiltInModuleManifests().find((manifest) => manifest.id === "chat");
    expect(chat?.database?.migrations).toEqual(
      expect.arrayContaining([
        "sql/0276_meeting_chat_cleanup.sql",
        "sql/0277_chat_surface_immutable.sql"
      ])
    );
    expect(meeting?.navigation).toEqual([
      expect.objectContaining({
        id: "meetings",
        path: "/meetings",
        icon: "mic",
        permissionId: "meetings.read"
      })
    ]);
    expect(meeting?.routes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "PUT /api/meetings/records/:id/title",
      "GET /api/meetings/output-availability",
      "POST /api/meetings/capture/connection",
      "POST /api/meetings/capture/commands",
      "POST /api/meetings/capture/claim",
      "GET /api/meetings/capture/devices",
      "POST /api/meetings/records/:id/capture/cancel-start",
      "POST /api/meetings/capture/status",
      "POST /api/meetings/capture/control",
      "POST /api/meetings/capture/audio",
      "GET /api/meetings/records/:id/capture",
      "POST /api/meetings/records/:id/capture/start",
      "POST /api/meetings/records/:id/capture/control",
      "POST /api/meetings/history/search",
      "GET /api/meetings/history/:id",
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
      "meetings.chat_app_actions",
      "meetings.link_state",
      "meetings.mac_link_controls",
      "meetings.automatic_summary",
      "transcribe.meeting",
      "meetings.native_startup_recovery",
      "meetings.native_source_recovery",
      "meetings.speaker_echo_control",
      "meetings.native_capture",
      "meetings.mac_recording_status",
      "meetings.mac_recording_pill_visibility",
      "meetings.mac_audio_sources",
      "meetings.account_export",
      "meetings.history",
      "meetings.unsaved_changes",
      "meetings.referenced_evidence",
      "meetings.private_exports",
      "meetings.summary.validation",
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
