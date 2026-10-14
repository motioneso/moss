import { describe, expect, it } from "vitest";
import {
  boundedActionScope,
  termsFingerprint,
  typedResponsibilityAgreement
} from "../../packages/chat/src/responsibility-agreements/terms.js";
import { proposalBindingMatches } from "../../packages/chat/src/responsibility-agreements/repository.js";
import { namesBoundedActionRequest } from "../../packages/chat/src/responsibility-agreements/prepare.js";
const scope = {
  operation: "tasks.updateStatus",
  taskId: "11111111-1111-4111-8111-111111111111",
  taskTitle: "Proof",
  status: "done",
  dueAt: "2026-10-13T10:00:00.000Z",
  timeZone: "UTC",
  destinationThreadId: "22222222-2222-4222-8222-222222222222"
};
describe("bounded inert agreement terms", () => {
  it("accepts only the exact supported immutable action shape", () => {
    expect(boundedActionScope(scope)).toEqual(scope);
    for (const changed of [
      { ...scope, operation: "tasks.delete" },
      { ...scope, status: "archived" },
      { ...scope, recipient: "other" },
      { ...scope, taskId: "wrong" },
      { ...scope, dueAt: "invalid" },
      { ...scope, timeZone: "invented" }
    ])
      expect(boundedActionScope(changed)).toBeUndefined();
  });
  it("binds every term while remaining stable under jsonb key ordering", () => {
    expect(termsFingerprint(scope)).toBe(
      termsFingerprint(Object.fromEntries(Object.entries(scope).reverse()))
    );
    for (const changed of [
      { ...scope, taskId: "33333333-3333-4333-8333-333333333333" },
      { ...scope, status: "todo" },
      { ...scope, dueAt: "2026-10-13T11:00:00.000Z" },
      { ...scope, timeZone: "Europe/London" }
    ])
      expect(termsFingerprint(changed)).not.toBe(termsFingerprint(scope));
  });
  it.each(["yes", "YES!", " yes. ", "\tyes\n"])("accepts an unmodified typed %j", (text) =>
    expect(typedResponsibilityAgreement(text)).toBe(true)
  );
  it.each(["no", "NO!"])("declines %j", (text) =>
    expect(typedResponsibilityAgreement(text)).toBe(false)
  );
  it.each([
    "\u00a0yes\u00a0",
    "yes but delete it",
    "yes, in an hour instead",
    '"yes"',
    "sure",
    "yes please",
    "the email says yes",
    "yes\nchange its owner"
  ])("does not approve revised or outside text %j", (text) =>
    expect(typedResponsibilityAgreement(text)).toBeUndefined()
  );
  it("requires exact persisted proposal provenance", () => {
    const expected = {
      id: "proposal",
      kind: "creation",
      version: 2,
      fingerprint: termsFingerprint(scope)
    };
    expect(proposalBindingMatches({ origin: { responsibilityProposal: expected } }, expected)).toBe(
      true
    );
    for (const changed of [
      { ...expected, id: "older" },
      { ...expected, kind: "edit" },
      { ...expected, version: 1 },
      { ...expected, fingerprint: "wrong" },
      { ...expected, authority: true }
    ])
      expect(
        proposalBindingMatches({ origin: { responsibilityProposal: changed } }, expected)
      ).toBe(false);
    expect(proposalBindingMatches({ origin: { event: "scope_proposed" } }, expected)).toBe(false);
  });
  it("leaves normal chat and unsupported broad recognition outside the adapter", () => {
    expect(namesBoundedActionRequest("Mark task Proof done in 10 minutes")).toBe(true);
    expect(namesBoundedActionRequest("Delete task Proof in 10 minutes")).toBe(true);
    expect(namesBoundedActionRequest("How is my task doing?")).toBe(false);
    expect(namesBoundedActionRequest("Remind me in 10 minutes to mark my task done")).toBe(false);
  });
});
