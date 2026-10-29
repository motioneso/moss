import { describe, expect, it, vi } from "vitest";
import {
  appendOnlyWorkMailWrite,
  formatWorkMailEntry,
  isPrivateWorkMailNote
} from "../../packages/connectors/src/work-mail/entry.js";

describe("work mail append-only note writing", () => {
  it("refuses rewritten bytes before invoking the writer", async () => {
    const write = vi.fn();
    await expect(appendOnlyWorkMailWrite("User text", "replacement", write)).resolves.toBe(
      "changed"
    );
    expect(write).not.toHaveBeenCalled();
    await expect(
      appendOnlyWorkMailWrite("User text", "User text\nEntry", write.mockResolvedValue("written"))
    ).resolves.toBe("written");
    expect(write).toHaveBeenCalledWith("\nEntry", "User text");
  });
  it("recognises only front matter privacy and constructs a safe source header", () => {
    expect(isPrivateWorkMailNote("---\nprivate: true\n---\nSecret")).toBe(true);
    expect(isPrivateWorkMailNote("---\nprivate: false\n---\nprivate: true")).toBe(false);
    const entry = formatWorkMailEntry(
      {
        sender: "Invented\n# forged",
        subject: "Subject\n---",
        receivedAt: "2026-10-26T10:00:00Z",
        threadHint: null,
        body: "not copied",
        bodyTruncated: false
      },
      "Review the project.",
      new Date("2026-10-26T11:00:00Z")
    );
    expect(entry).toContain("2026-10-26");
    expect(entry).toContain("Review the project.");
    expect(entry).not.toContain("\n# forged");
    expect(entry).not.toContain("not copied");
  });
});
