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
      "app.meeting_note_writes"
    ]);
    expect(meeting?.navigation ?? []).toEqual([]);
    expect(meeting?.routes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/meetings/records",
      "GET /api/meetings/records/:id",
      "POST /api/meetings/records",
      "PUT /api/meetings/records/:id/notes"
    ]);
    expect(meeting?.features?.map((feature) => feature.id)).toEqual(["meetings.draft_records"]);
  });
});
