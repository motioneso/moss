import { describe, expect, it } from "vitest";
import { actionApprovalText } from "@moss/shared";

describe("plain approval failure outcomes", () => {
  it.each([
    ["approval_changed: private input", "The item changed while you were deciding."],
    ["unknown_route: /api/records/private-id", "The action or item is no longer available."],
    ["consent_off: secret details", "Access to this information is turned off."],
    ["not_ready: dependency code", "The app is not ready yet."],
    ["invalid_call_binding: private hash", "This approval no longer matches the request."],
    ["blocked: private command", "This action is not available through chat."],
    ["Tool app.callAction failed", "The app reported a problem."],
    ["https://private.test/api?body=secret", "The app reported a problem."],
    ['/api/private/123 {"body":"secret"}', "The app reported a problem."],
    ["TypeError: unsafe.code() at /private/path.ts:12", "The app reported a problem."],
    [undefined, "The app reported a problem."]
  ])("never echoes technical reason %s", (reason, expected) => {
    expect(
      actionApprovalText({
        outcome: "error",
        decidedBy: "person",
        summary: "Rename your meeting",
        reason
      })
    ).toBe(`Approved, but it didn’t go through · Rename your meeting · ${expected}`);
  });

  it("does not relabel a user decline as an execution failure", () => {
    expect(
      actionApprovalText({
        outcome: "denied",
        decidedBy: "person",
        summary: "Send the note",
        reason: "private detail"
      })
    ).toBe("You declined · Send the note");
    expect(
      actionApprovalText({ outcome: "error", decidedBy: "policy", reason: "private detail" })
    ).toBeNull();
  });
});
