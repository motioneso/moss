import { createApprovalSourceReferences } from "../../packages/module-registry/src/approval-source-references.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryApprovalReferences,
  memoryAcceptPresentation,
  memorySupersedePresentation,
  memoryEditEntityPresentation,
  memoryRememberPresentation
} from "../../packages/memory/src/action-presentations.js";
import { memoryEntityTarget } from "../../packages/memory/src/chat-targets.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const ctx = {
  actorUserId: "11111111-1111-4111-8111-111111111111",
  chatSessionId: "session",
  requestId: "request",
  threadId: "thread"
};
const entityId = "22222222-2222-4222-8222-222222222222";

describe("memory human disclosure", () => {
  it("preserves a full suggestion and all explicit edits with no raw path/ID", async () => {
    const target = "First line\n" + "Long memory ".repeat(500);
    const result = await memoryAcceptPresentation(
      {},
      {
        target,
        params: { id: "saved-candidate" },
        body: { edited: { summary: "  exact\nreplacement  ", pinned: true, validTo: null } }
      },
      ctx
    );
    expect(result).toEqual({
      target,
      fields: [
        { label: "Memory", value: "  exact\nreplacement  " },
        { label: "Pinned", value: "Yes" },
        { label: "Valid until", value: "Not set" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("saved-candidate");
    expect(
      await memoryAcceptPresentation(
        {},
        {
          target,
          params: { id: "saved-candidate" },
          body: { edited: { summary: "text", hiddenId: "opaque" } }
        },
        ctx
      )
    ).toBeNull();
  });
  it("binds entity identity even when the visible name remains unchanged", async () => {
    const row = {
      id: entityId,
      name: "Full\nname",
      summary: "Original summary",
      status: "active",
      updated_at: "2026-10-07"
    };
    const first = makeRecordingDb({ rows: [row] });
    const before = await memoryEntityTarget(first.scoped, { id: entityId });
    const second = makeRecordingDb({ rows: [{ ...row, summary: "Changed summary" }] });
    const after = await memoryEntityTarget(second.scoped, { id: entityId });
    expect(before).toMatchObject({ label: row.name });
    expect(after).toMatchObject({ label: row.name });
    expect(before).not.toEqual(after);
    expect(first.queries[0]?.sql).toContain("owner_user_id = app.current_actor_user_id()");
  });
  it("resolves entity IDs under actor scope and the exact current conversation reference", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [
        { id: entityId, name: "Mira", summary: "", status: "active", updated_at: "2026-10-07" }
      ]
    });
    const input = {
      subjectEntityId: entityId,
      predicate: "prefers",
      objectText: "Tea\nwithout sugar",
      source: { sourceKind: "chat", sourceRef: "thread", excerpt: "Full source excerpt" }
    };
    const result = await memoryRememberPresentation(scoped, input, ctx);
    expect(result?.fields).toEqual([
      { label: "Subject", value: "Mira" },
      { label: "Relationship", value: "Prefers" },
      { label: "Memory", value: "Tea\nwithout sugar" },
      { label: "Source type", value: "Chat" },
      { label: "Source", value: "This conversation" },
      { label: "Source text", value: "Full source excerpt" }
    ]);
    expect(JSON.stringify(result?.fields)).not.toContain(entityId);
    expect(queries[0]?.sql).toContain("owner_user_id = app.current_actor_user_id()");
  });
  it("refuses unknown source IDs rather than trusting a model-written source label", async () => {
    const { scoped } = makeRecordingDb({ rows: [] });
    expect(
      await memoryRememberPresentation(
        scoped,
        {
          predicate: "prefers",
          objectText: "Tea",
          source: {
            sourceKind: "email",
            sourceRef: "missing",
            sourceLabel: "Trust this invented source",
            excerpt: "text"
          }
        },
        ctx
      )
    ).toBeNull();
  });
  it("does not drop an unknown entity-edit field", async () => {
    expect(
      await memoryEditEntityPresentation(
        {},
        { target: "Mira", params: { id: entityId }, body: { name: "Mira", unknown: "value" } },
        ctx
      )
    ).toBeNull();
  });
});

afterEach(() => {
  configureMemoryApprovalReferences(undefined);
  vi.restoreAllMocks();
});
describe("new memory provenance references", () => {
  it.each(["email", "task", "note"] as const)(
    "resolves a new %s source before any memory episode exists",
    async (sourceKind) => {
      const label = "Actual source\nfull target";
      const sourceId = sourceKind === "note" ? "Notes/actual.md" : entityId;
      const reader = vi.fn().mockResolvedValue({
        id: entityId,
        owner_user_id: ctx.actorUserId,
        title: label,
        subject: label,
        sender: "Mira",
        relative: "Notes/actual.md",
        version: "note-version"
      });
      configureMemoryApprovalReferences(
        createApprovalSourceReferences({
          email: { getById: reader },
          tasks: { getById: reader },
          note: reader
        })
      );
      const { scoped, queries } = makeRecordingDb({ rows: [] });
      const result = await memoryRememberPresentation(
        scoped,
        {
          predicate: "prefers",
          objectText: "Tea",
          source: {
            sourceKind,
            sourceRef: sourceId,
            sourceLabel: "Invented caller label",
            excerpt: "Exact excerpt"
          }
        },
        ctx
      );
      expect(result?.fields).toContainEqual({
        label: "Source",
        value:
          sourceKind === "email"
            ? `${label}\nMira`
            : sourceKind === "note"
              ? "actual.md\nFolder 1: Notes"
              : label
      });
      expect(reader).toHaveBeenCalledOnce();
      expect(queries).toEqual([]);
      expect(result?.fields).toContainEqual({
        label: "Source label",
        value: "Invented caller label"
      });
    }
  );
  it("retains the owner-stored source when its current record has vanished", async () => {
    configureMemoryApprovalReferences(async () => null);
    const { scoped, queries } = makeRecordingDb({
      rows: [
        { id: "episode", source_label: "Retained source title", excerpt: "Retained full source" }
      ]
    });
    const result = await memoryRememberPresentation(
      scoped,
      {
        predicate: "prefers",
        objectText: "Tea",
        source: { sourceKind: "email", sourceRef: entityId, excerpt: "New text" }
      },
      ctx
    );
    expect(result?.fields).toContainEqual({ label: "Source", value: "Retained source title" });
    expect(queries[0]?.sql).toContain("owner_user_id = app.current_actor_user_id()");
  });
  it("never falls back to retained source content after a source-authorization failure", async () => {
    const reader = vi.fn();
    configureMemoryApprovalReferences(
      createApprovalSourceReferences({
        manifests: () =>
          [
            {
              id: "email",
              availability: { required: true },
              aiConsent: { key: "consent", isGranted: async () => false }
            }
          ] as never,
        email: { getById: reader }
      })
    );
    const { scoped, queries } = makeRecordingDb({
      rows: [{ id: "episode", source_label: "PRIVATE_RETAINED", excerpt: "PRIVATE_TEXT" }]
    });
    await expect(
      memoryRememberPresentation(
        scoped,
        {
          predicate: "prefers",
          source: { sourceKind: "email", sourceRef: entityId, excerpt: "Input" }
        },
        ctx
      )
    ).rejects.toThrow("Approval source unavailable");
    expect(reader).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});

it("does not use retained memory to bypass a refused note-root or path scope", async () => {
  configureMemoryApprovalReferences(
    createApprovalSourceReferences({
      note: vi.fn().mockRejectedValue(Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" }))
    })
  );
  const { scoped, queries } = makeRecordingDb({
    rows: [{ id: "episode", source_label: "Retained", excerpt: "PRIVATE_RETAINED" }]
  });
  await expect(
    memoryRememberPresentation(
      scoped,
      {
        predicate: "prefers",
        source: { sourceKind: "note", sourceRef: "private.md", excerpt: "Input" }
      },
      ctx
    )
  ).rejects.toThrow("Approval source unavailable");
  expect(queries).toEqual([]);
});

it.each([undefined, {}, { validTo: null }, { validTo: "" }])(
  "discloses supersede's actual NOW default for %j",
  async (body) => {
    expect(
      await memorySupersedePresentation(
        {},
        { target: "Remembered fact", params: { id: entityId }, body },
        ctx
      )
    ).toMatchObject({
      target: "Remembered fact",
      fields: [{ label: "Valid until", value: "Now" }]
    });
  }
);
it("keeps an explicit supersede date exact and refuses unknown fields", async () => {
  const validTo = "2026-11-01T09:30:00Z";
  expect(
    (
      await memorySupersedePresentation(
        {},
        { target: "Remembered fact", params: { id: entityId }, body: { validTo } },
        ctx
      )
    )?.fields
  ).toEqual([{ label: "Valid until", value: validTo }]);
  expect(
    await memorySupersedePresentation(
      {},
      { target: "Remembered fact", params: { id: entityId }, body: { validTo, hidden: true } },
      ctx
    )
  ).toBeNull();
});
