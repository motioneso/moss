import { beforeEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";

const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock("../../packages/notes/src/write-tools.js", () => ({
  resolveNoteApprovalTarget: resolveTarget
}));
import {
  notesCreatePresentation,
  notesDeletePresentation,
  notesEditPresentation
} from "../../packages/notes/src/approval-presentation.js";

const db = { [dataContextBrand]: true, db: {} };
const ctx = { actorUserId: "owner", requestId: "request", chatSessionId: "chat" } as ToolContext;

beforeEach(() => {
  resolveTarget.mockReset();
  resolveTarget.mockResolvedValue({
    relative: "Work/Plans › personal/Next week.md",
    version: "server-only-version"
  });
});

describe("server-owned note approval presentations", () => {
  it("keeps the exact note name, folder components and full content without an absolute path", async () => {
    const content = `First line\n${"long text ".repeat(500)}<script>not markup</script>`;
    const result = await notesCreatePresentation(
      db,
      {
        path: "/private/root/Work/Plans › personal/Next week.md",
        content,
        overwrite: true
      },
      ctx
    );
    expect(result).toEqual({
      title: "Overwrite note",
      target: "Next week.md",
      fields: [
        { label: "Folder 1", value: "Work" },
        { label: "Folder 2", value: "Plans › personal" },
        { label: "Content", value: content },
        { label: "Replace existing content", value: "Yes" }
      ],
      version: "server-only-version"
    });
    expect(JSON.stringify(result)).not.toContain("/private/root");
    expect(resolveTarget).toHaveBeenCalledWith(
      db,
      "/private/root/Work/Plans › personal/Next week.md",
      true
    );
  });

  it.each([undefined, false])(
    "keeps the create heading when overwrite is %s",
    async (overwrite) => {
      const result = await notesCreatePresentation(
        db,
        {
          path: "new.md",
          content: "New content",
          ...(overwrite === undefined ? {} : { overwrite })
        },
        ctx
      );
      expect(result?.title).toBe("Create note");
    }
  );

  it("discloses both exact edit strings, including an empty replacement", async () => {
    expect(
      (
        await notesEditPresentation(
          db,
          { path: "Next week.md", oldText: "old\ntext", newText: "" },
          ctx
        )
      )?.fields
    ).toContainEqual({ label: "Replace", value: "old\ntext" });
    expect(
      (
        await notesEditPresentation(
          db,
          { path: "Next week.md", oldText: "old\ntext", newText: "" },
          ctx
        )
      )?.fields
    ).toContainEqual({ label: "With", value: "" });
    expect(resolveTarget).toHaveBeenLastCalledWith(db, "Next week.md", false);
  });

  it("discloses permanent deletion with its server-authored danger identity", async () => {
    resolveTarget.mockResolvedValue({ relative: "Next week.md", version: "v1" });
    expect(await notesDeletePresentation(db, { path: "Next week.md" }, ctx)).toEqual({
      approvalKind: "note_delete",
      target: "Next week.md",
      fields: [
        { label: "Deletion", value: "Permanently delete this note. There is no trash or undo." }
      ],
      version: "v1"
    });
  });

  it.each([
    { path: "note.md", content: "text", unknownId: "hidden" },
    { path: "note.md", content: { text: "nested" } },
    { path: "note.md", content: "text", overwrite: "yes" },
    { path: "note.md" },
    { content: "text" }
  ])("refuses incomplete or unmapped submitted values before target lookup: %j", async (input) => {
    expect(await notesCreatePresentation(db, input, ctx)).toBeNull();
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied danger marker rather than treating it as authority", async () => {
    expect(
      await notesDeletePresentation(db, { path: "note.md", approvalKind: "note_delete" }, ctx)
    ).toBeNull();
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("does not swallow target access failures into an approvable card", async () => {
    resolveTarget.mockRejectedValue(new Error("unavailable"));
    await expect(notesDeletePresentation(db, { path: "note.md" }, ctx)).rejects.toThrow(
      "unavailable"
    );
  });
});
