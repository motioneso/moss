import { dataContextBrand } from "@moss/db";
import { GoalsRepository } from "../../packages/goals/src/repository.js";
import { goalEvidencePresentation } from "../../packages/goals/src/approval-presentation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalSourceReferences } from "../../packages/module-registry/src/approval-source-references.js";
const actor = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const db = {} as never;
describe("goal source references use public actor-scoped readers", () => {
  it("resolves an exact task title with a server-only version and refuses other owners", async () => {
    const row = { id, owner_user_id: actor, title: "Full\ntask title", updated_at: "2026-10-07" };
    const getById = vi.fn().mockResolvedValue(row);
    const resolve = createApprovalSourceReferences({ tasks: { getById } });
    const input = { actorUserId: actor, sourceKind: "task" as const, sourceRef: id };
    expect(await resolve(db, input)).toMatchObject({
      label: row.title,
      version: expect.any(String)
    });
    expect(getById).toHaveBeenCalledWith(db, id);
    getById.mockResolvedValue({ ...row, owner_user_id: "other" });
    expect(await resolve(db, input)).toBeNull();
  });
  it("resolves full owned email and chat labels without using caller-provided source labels", async () => {
    const resolve = createApprovalSourceReferences({
      email: {
        getById: vi.fn().mockResolvedValue({
          id,
          owner_user_id: actor,
          subject: "Subject",
          sender: "Mira <mira@example.test>"
        })
      },
      chat: {
        getThreadById: vi
          .fn()
          .mockResolvedValue({ id: "thread", owner_user_id: actor, incognito: false }),
        getMessageById: vi.fn().mockResolvedValue({
          id,
          owner_user_id: actor,
          body: "Full\nchat text",
          thread_id: "thread",
          tool_metadata: null
        })
      }
    });
    expect(
      (await resolve(db, { actorUserId: actor, sourceKind: "email", sourceRef: id }))?.label
    ).toBe("Subject\nMira <mira@example.test>");
    expect(
      (await resolve(db, { actorUserId: actor, sourceKind: "chat", sourceRef: id }))?.label
    ).toBe("Full\nchat text");
  });
  it("refuses invalid/unsupported references without a fabricated label", async () => {
    const getById = vi.fn();
    const resolve = createApprovalSourceReferences({ tasks: { getById } });
    expect(
      await resolve(db, { actorUserId: actor, sourceKind: "task", sourceRef: "not-an-id" })
    ).toBeNull();
    expect(await resolve(db, { actorUserId: actor, sourceKind: "goal", sourceRef: id })).toBeNull();
    expect(getById).not.toHaveBeenCalled();
  });
});

it("resolves configured note paths and memory facts through their owning public APIs", async () => {
  const note = vi
    .fn()
    .mockResolvedValue({ relative: "Projects/Plans/today.md", version: "note-version" });
  const memoryTarget = vi
    .fn()
    .mockResolvedValue({ label: "Full\nmemory text", version: "memory-version" });
  const resolve = createApprovalSourceReferences({ note, memory: { target: memoryTarget } });
  expect(
    await resolve(db, {
      actorUserId: actor,
      sourceKind: "note",
      sourceRef: "Projects/Plans/today.md"
    })
  ).toEqual({ label: "today.md\nFolder 1: Projects\nFolder 2: Plans", version: "note-version" });
  expect(note).toHaveBeenCalledWith(db, "Projects/Plans/today.md", false);
  expect(await resolve(db, { actorUserId: actor, sourceKind: "memory", sourceRef: id })).toEqual({
    label: "Full\nmemory text",
    version: "memory-version"
  });
  expect(memoryTarget).toHaveBeenCalledWith(db, actor, id);
});

afterEach(() => vi.restoreAllMocks());
it("renders manual source references as exact submitted text without identifier heuristics", async () => {
  vi.spyOn(GoalsRepository.prototype, "getById").mockResolvedValue({
    id,
    title: "My goal",
    updatedAt: "today"
  } as never);
  const sourceRef = "my_notes.v2 - item_42\n" + "Full text ".repeat(500);
  const result = await goalEvidencePresentation(
    { [dataContextBrand]: true, db: {} },
    {
      goalId: id,
      evidenceKind: "context",
      sourceKind: "manual",
      sourceRef,
      sourceLabel: "User supplied",
      summary: "Evidence"
    },
    { actorUserId: actor, requestId: "request", chatSessionId: "session" }
  );
  expect(result?.fields).toContainEqual({ label: "Manual reference", value: sourceRef });
});

it.each(["incognito", "meeting"] as const)(
  "does not disclose a %s chat source through ordinary goal/memory references",
  async (kind) => {
    const resolve = createApprovalSourceReferences({
      chat: {
        getMessageById: vi.fn().mockResolvedValue({
          id,
          owner_user_id: actor,
          thread_id: "thread",
          body: "PRIVATE_CONTENT",
          tool_metadata: kind === "meeting" ? { meetingChatV1: {} } : null
        }),
        getThreadById: vi.fn().mockResolvedValue({
          id: "thread",
          owner_user_id: actor,
          incognito: kind === "incognito"
        })
      }
    });
    await expect(
      resolve(db, { actorUserId: actor, sourceKind: "chat", sourceRef: id })
    ).rejects.toThrow("Approval source unavailable");
  }
);

it("distinguishes a vanished note from a note-root or path-scope refusal", async () => {
  const missing = createApprovalSourceReferences({
    note: vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }))
  });
  expect(
    await missing(db, { actorUserId: actor, sourceKind: "note", sourceRef: "old.md" })
  ).toBeNull();
  const denied = createApprovalSourceReferences({
    note: vi.fn().mockRejectedValue(Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" }))
  });
  await expect(
    denied(db, { actorUserId: actor, sourceKind: "note", sourceRef: "private.md" })
  ).rejects.toThrow("Approval source unavailable");
});
