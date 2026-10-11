/**
 * #1133 — chat.readAttachment tool execute.
 *
 * Real ChatAttachmentsService over a tmpdir vault; no DB (the tool never touches
 * scopedDb — vault ownership is structural via ctx.actorUserId). Proves the three
 * result shapes: image → data WITHOUT bytes + `media` payload (the gateway forwards
 * media over MCP stdio, bypassing renderAndCap), text → extracted text inline, and
 * unknown/foreign id → soft "Attachment not found" data error.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";
import { renderToolResult } from "@moss/module-sdk";
import { VaultContextRunner } from "@moss/vault";

import { chatReadAttachmentExecute } from "../../packages/chat/src/attachment-tool.js";
import { ChatAttachmentsService } from "../../packages/chat/src/attachments-service.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-body")
]);

const scopedDb = null as unknown as DataContextDb;

describe("chat.readAttachment execute (#1133)", () => {
  let vaultBase: string;
  let service: ChatAttachmentsService;
  const actorUserId = randomUUID();
  const ctx = { actorUserId, requestId: randomUUID(), chatSessionId: "" };

  beforeAll(async () => {
    vaultBase = await mkdtemp(join(tmpdir(), "jarvis-attach-tool-"));
    service = new ChatAttachmentsService(new VaultContextRunner(vaultBase));
  });

  afterAll(async () => {
    await rm(vaultBase, { recursive: true, force: true });
  });

  const services = () => ({ chatAttachments: service });

  it("throws when the service is not wired (gateway reports generic tool failure)", async () => {
    await expect(
      chatReadAttachmentExecute(scopedDb, { attachmentId: randomUUID() }, ctx, {})
    ).rejects.toThrow("chat attachments service unavailable");
  });

  it("returns a soft not-found error for an unknown id", async () => {
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: randomUUID() },
      ctx,
      services()
    );
    expect(result.data).toEqual({ error: "Attachment not found" });
  });

  it("cannot read another user's attachment (structural vault ownership)", async () => {
    const meta = await service.saveAttachment(
      { actorUserId: randomUUID(), requestId: randomUUID() },
      { fileName: "theirs.png", mimeType: "image/png", bytes: PNG_BYTES }
    );
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id },
      ctx,
      services()
    );
    expect(result.data).toEqual({ error: "Attachment not found" });
  });

  it("returns images as media with metadata-only data", async () => {
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "shot.png", mimeType: "image/png", bytes: PNG_BYTES }
    );
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id },
      ctx,
      services()
    );
    expect(result.data).toEqual({ fileName: "shot.png", mimeType: "image/png" });
    expect(result.media).toEqual({
      kind: "image",
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png"
    });
  });

  it("returns text files as inline extracted text with no media", async () => {
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello attachment") }
    );
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id },
      ctx,
      services()
    );
    expect(result.data).toMatchObject({
      fileName: "notes.txt",
      mimeType: "text/plain",
      totalChars: 16,
      offset: 0,
      text: "hello attachment"
    });
    expect(result.data).not.toHaveProperty("nextOffset");
    expect(result.media).toBeUndefined();
  });

  it("reads a document longer than the old cap to the end across calls (#3342)", async () => {
    const text = `${"benefit detail line\n".repeat(3000)}Deductible: $1,500 per person.\n`;
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "benefits.txt", mimeType: "text/plain", bytes: Buffer.from(text, "utf8") }
    );
    const read = await readToEnd(meta.id);
    expect(read.totalChars).toBe(text.length);
    expect(read.text).toBe(text);
    expect(read.calls).toBeGreaterThan(1);
  });

  it("keeps every page under the gateway render cap when the text is escape-heavy (#3342)", async () => {
    const text = '"quoted"\n'.repeat(4000);
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "quotes.txt", mimeType: "text/plain", bytes: Buffer.from(text, "utf8") }
    );
    const read = await readToEnd(meta.id);
    expect(read.text).toBe(text);
  });

  it("says the total length, the range returned, and where to continue (#3342)", async () => {
    const text = "x".repeat(40_000);
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "long.txt", mimeType: "text/plain", bytes: Buffer.from(text, "utf8") }
    );
    const first = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id },
      ctx,
      services()
    );
    const data = first.data as {
      text: string;
      totalChars: number;
      offset: number;
      nextOffset: number;
      note: string;
    };
    expect(data.totalChars).toBe(40_000);
    expect(data.offset).toBe(0);
    expect(data.nextOffset).toBe(data.text.length);
    expect(data.note).toContain(`offset ${data.nextOffset}`);
    expect(data.note).toContain("28000 characters remain unread");
    // The reading position must come before the text, so a long page cannot hide it.
    const keys = Object.keys(data);
    expect(keys.indexOf("nextOffset")).toBeLessThan(keys.indexOf("text"));
    expect(keys.indexOf("note")).toBeLessThan(keys.indexOf("text"));
  });

  it("honors a smaller limit and clamps an oversized one (#3342)", async () => {
    const text = "y".repeat(40_000);
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "limits.txt", mimeType: "text/plain", bytes: Buffer.from(text, "utf8") }
    );
    const small = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id, limit: 500 },
      ctx,
      services()
    );
    expect((small.data as { text: string }).text).toHaveLength(500);
    expect((small.data as { nextOffset: number }).nextOffset).toBe(500);

    const huge = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id, limit: 1_000_000 },
      ctx,
      services()
    );
    const hugeText = (huge.data as { text: string }).text;
    expect(hugeText.length).toBeGreaterThan(0);
    expect(hugeText.length).toBeLessThanOrEqual(12_000);
  });

  it("returns no text and no next offset when offset is past the end (#3342)", async () => {
    const meta = await service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName: "short.txt", mimeType: "text/plain", bytes: Buffer.from("abc") }
    );
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId: meta.id, offset: 99 },
      ctx,
      services()
    );
    expect(result.data).toMatchObject({ totalChars: 3, text: "" });
    expect(result.data).not.toHaveProperty("nextOffset");
  });

  interface SearchData extends Record<string, unknown> {
    matches: { offset: number; passage: string }[];
    matchCount: number;
    nextOffset?: number;
    note: string;
  }

  async function saveText(fileName: string, text: string) {
    return service.saveAttachment(
      { actorUserId, requestId: randomUUID() },
      { fileName, mimeType: "text/plain", bytes: Buffer.from(text, "utf8") }
    );
  }

  async function searchAttachment(attachmentId: string, search: string, offset?: number) {
    const result = await chatReadAttachmentExecute(
      scopedDb,
      { attachmentId, search, ...(offset === undefined ? {} : { offset }) },
      ctx,
      services()
    );
    return result.data as SearchData;
  }

  it("finds a figure and returns its offset and the text around it (#3342)", async () => {
    const text = `${"z".repeat(30_000)}Out-of-network deductible: $4,350 per person.${"z".repeat(10_000)}`;
    const meta = await saveText("plan.txt", text);
    const found = await searchAttachment(meta.id, "4,350");
    // 30,000 filler characters and "Out-of-network deductible: $" (28 characters) come first.
    expect(found.matches.map((match) => match.offset)).toEqual([30_028]);
    expect(text.slice(30_028, 30_033)).toBe("4,350");
    expect(found.matches[0]?.passage).toContain("4,350");
    expect(found.matchCount).toBe(1);
    expect(found).not.toHaveProperty("nextOffset");
  });

  it("returns at most six matches, then says where to continue (#3342)", async () => {
    // Each block is 1,005 characters, so each match starts 1,005 characters after the last.
    const block = `needle${"-".repeat(999)}`;
    const meta = await saveText("needles.txt", block.repeat(8));
    const first = await searchAttachment(meta.id, "needle");
    expect(first.matches.map((match) => match.offset)).toEqual([0, 1005, 2010, 3015, 4020, 5025]);
    expect(first.matchCount).toBe(8);
    expect(first.nextOffset).toBe(6030);
    const keys = Object.keys(first);
    expect(keys.indexOf("note")).toBeLessThan(keys.indexOf("matches"));
    const rest = await searchAttachment(meta.id, "needle", first.nextOffset);
    expect(rest.matches.map((match) => match.offset)).toEqual([6030, 7035]);
    expect(rest).not.toHaveProperty("nextOffset");
  });

  it("ignores capitals and reads the term literally (#3342)", async () => {
    const text = "Deductible: $100. Plan (PPO) covers it.";
    const meta = await saveText("terms.txt", text);
    const capitals = await searchAttachment(meta.id, "deductible");
    expect(capitals.matches.map((match) => match.offset)).toEqual([0]);
    expect(text.slice(23, 28)).toBe("(PPO)");
    const literal = await searchAttachment(meta.id, "(PPO)");
    expect(literal.matches.map((match) => match.offset)).toEqual([23]);
  });

  it("says when a search finds nothing, and asks for a read to the end first (#3342)", async () => {
    const meta = await saveText("empty-search.txt", "Only ordinary words here.");
    const found = await searchAttachment(meta.id, "zzz-not-here");
    expect(found.matches).toEqual([]);
    expect(found.matchCount).toBe(0);
    expect(found.note).toContain('No match for "zzz-not-here"');
    expect(found.note).toContain("Read the file to the end");
  });

  it("keeps a search result under the gateway render cap when passages are escape-heavy (#3342)", async () => {
    const meta = await saveText("quotes-search.txt", '"'.repeat(20_000));
    const found = await searchAttachment(meta.id, '"');
    expect(renderToolResult({ data: found }).length).toBeLessThanOrEqual(16_000);
    expect(found.matches.length).toBeGreaterThan(0);
  });

  // Reads pages until the tool reports no next offset, checking each page against the
  // gateway's 16,000 rendered-character cap (output-validation.ts renderAndCap).
  async function readToEnd(attachmentId: string) {
    const pieces: string[] = [];
    let offset: number | undefined;
    for (let calls = 1; calls <= 100; calls += 1) {
      const result = await chatReadAttachmentExecute(
        scopedDb,
        { attachmentId, ...(offset === undefined ? {} : { offset }) },
        ctx,
        services()
      );
      expect(renderToolResult({ data: result.data }).length).toBeLessThanOrEqual(16_000);
      const data = result.data as { text: string; totalChars: number; nextOffset?: number };
      pieces.push(data.text);
      if (data.nextOffset === undefined) {
        return { text: pieces.join(""), totalChars: data.totalChars, calls };
      }
      offset = data.nextOffset;
    }
    throw new Error("reading did not reach the end of the attachment");
  }
});
