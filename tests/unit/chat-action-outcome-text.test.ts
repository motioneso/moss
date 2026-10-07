import { describe, expect, it } from "vitest";
import { actionOutcomeText } from "@moss/shared";

describe("plain approval failure outcomes", () => {
  it.each([
    ["approval_changed: private input", "The item changed before the action could finish."],
    ["unknown_route: /api/records/private-id", "The action or item is no longer available."],
    ["consent_off: secret details", "Access to this information is turned off."],
    ["not_ready: dependency code", "The app is not ready yet."],
    ["invalid_call_binding: private hash", "The action no longer matches the original request."],
    ["blocked: private command", "This action is not available through chat."],
    ["Tool app.callAction failed", "The app reported a problem."],
    ["https://private.test/api?body=secret", "The app reported a problem."],
    ['/api/private/123 {"body":"secret"}', "The app reported a problem."],
    ["TypeError: unsafe.code() at /private/path.ts:12", "The app reported a problem."],
    [undefined, "The app reported a problem."]
  ])("never echoes technical reason %s", (reason, expected) => {
    expect(
      actionOutcomeText({
        outcome: "error",
        decidedBy: "person",
        summary: "Rename your meeting",
        reason
      })
    ).toBe(`Approved, but it didn’t go through · Rename your meeting · ${expected}`);
  });

  it("does not relabel a user decline as an execution failure", () => {
    expect(
      actionOutcomeText({
        outcome: "denied",
        decidedBy: "person",
        summary: "Send the note",
        reason: "private detail"
      })
    ).toBe("You declined · Send the note");
    expect(
      actionOutcomeText({ outcome: "error", decidedBy: "policy", reason: "private detail" })
    ).toBe("The action didn’t go through · The app reported a problem.");
  });

  it("separates actual unattended execution from permission and approval", () => {
    expect(
      actionOutcomeText({ outcome: "executed", decidedBy: "policy", summary: "Create note" })
    ).toBe("Done: Create note");
    expect(
      actionOutcomeText({ outcome: "error", decidedBy: "policy", summary: "Create note" })
    ).toBe("Create note didn’t go through · The app reported a problem.");
    expect(
      actionOutcomeText({ outcome: "allowed", decidedBy: "policy", summary: "Use the app" })
    ).toBe("Allowed: Use the app");
    expect(
      actionOutcomeText({ outcome: "denied", decidedBy: "policy", summary: "Use the app" })
    ).toBe("Not allowed: Use the app");
    expect(actionOutcomeText({ outcome: "executed" })).toBe("Done");
  });

  it.each(["person", "policy"] as const)(
    "uses neutral binding-error reasons for %s failures",
    (decidedBy) => {
      for (const [code, text] of [
        ["approval_changed", "The item changed before the action could finish."],
        ["invalid_call_binding", "The action no longer matches the original request."]
      ]) {
        const result = actionOutcomeText({
          outcome: "error",
          decidedBy,
          summary: "Create note",
          reason: `${code}: private /path`
        });
        expect(result).toContain(text);
        expect(result).not.toMatch(/while you were deciding|This approval|private|\/path/);
        if (decidedBy === "policy") expect(result).not.toContain("Approved");
      }
    }
  );
});
