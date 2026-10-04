import { describe, expect, it } from "vitest";
import { getBuiltInModuleManifests } from "@moss/module-registry";

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
      "app.meeting_transcript_batches"
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
