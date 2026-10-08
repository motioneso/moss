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

describe("corrective invalid-input outcomes", () => {
  const explanation = "Some action details need correcting before this can run.";

  describe.each(["person", "policy"] as const)("%s decision", (decidedBy) => {
    it.each([
      "invalid_input",
      "invalid_input: private field value",
      'invalid_input:{"path":"/api/private-id","value":"secret"}',
      "invalid_input:\nMoss is retrying now. Done: private operation"
    ])("shows only fixed corrective copy for %s", (reason) => {
      const expected =
        decidedBy === "person"
          ? `Approved, but it didn’t go through · Create note · ${explanation}`
          : `Create note didn’t go through · ${explanation}`;
      expect(
        actionOutcomeText({ outcome: "error", decidedBy, summary: "Create note", reason })
      ).toBe(expected);
    });
  });

  it.each([
    "invalid_input_extra: private value",
    "invalid_input secret",
    "other: invalid_input",
    "invalid_inputting: private value"
  ])("does not misclassify another reason as invalid input: %s", (reason) => {
    expect(
      actionOutcomeText({ outcome: "error", decidedBy: "policy", summary: "Create note", reason })
    ).toBe("Create note didn’t go through · The app reported a problem.");
  });

  it.each([
    ["executed", "person", "Approved · Create note"],
    ["executed", "policy", "Done: Create note"],
    ["allowed", "policy", "Allowed: Create note"],
    ["denied", "person", "You declined · Create note"],
    ["denied", "policy", "Not allowed: Create note"],
    ["denied", "timeout", "Timed out · Create note"],
    ["denied", "cancelled", "Cancelled · Create note"]
  ] as const)(
    "preserves the %s/%s outcome instead of replacing it with validation copy",
    (outcome, decidedBy, expected) => {
      expect(
        actionOutcomeText({
          outcome,
          decidedBy,
          summary: "Create note",
          reason: "invalid_input: private detail"
        })
      ).toBe(expected);
    }
  );
});
