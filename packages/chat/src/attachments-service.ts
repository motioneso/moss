import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { AccessContext } from "@moss/db";
import {
  type VaultContext,
  type VaultContextRunner,
  deleteVaultDir,
  listVaultDirectories,
  readVaultFile,
  readVaultFileBytes,
  writeVaultFile,
  writeVaultFileBytes
} from "@moss/vault";
import JSZip from "jszip";
import mammoth from "mammoth";

/**
 * #1133 / #1154 — chat attachment storage. Bytes live in the actor's vault under
 * `attachments/<id>/{blob,meta.json}` (0600/0700 via VaultContext), never in the DB, logs,
 * or job payloads. Ownership is structural: every operation derives the vault root from
 * `access.actorUserId`, so a guessed id can never reach another user's file.
 */

// Whitelist is fail-closed: anything not matched here is rejected with 415 at upload.
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_WORKER_URL = new URL("./pdf.worker.mjs", import.meta.url);

export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 5;
// Abuse bound on uploads that never get sent (spec §2); GC below reaps them after 24h.
export const MAX_PENDING_ATTACHMENTS = 20;
export const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
// Module consumers (job search, briefings) get at most this many characters, with a truncation
// note. chat.readAttachment pages through the full text via readFullContent instead.
export const ATTACHMENT_TEXT_CAP_CHARS = 15_000;

export type AttachmentMimeKind = "image" | "pdf" | "docx" | "text";

export function classifyAttachmentMime(mimeType: string): AttachmentMimeKind | undefined {
  if (IMAGE_MIMES.has(mimeType)) return "image";
  if (mimeType === PDF_MIME) return "pdf";
  if (mimeType === DOCX_MIME) return "docx";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return undefined;
}

// Magic-byte signatures for the binary types. A declared binary mime whose bytes don't
// match is rejected — mislabeled text is harmless (read as text, worst case garbage), but
// mislabeled binaries would otherwise let e.g. a PDF masquerade as a PNG.
async function sniffMatches(mimeType: string, bytes: Buffer): Promise<boolean> {
  const starts = (sig: number[], offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  switch (mimeType) {
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "image/gif":
      return starts([0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      // RIFF....WEBP — bytes 0-3 "RIFF", bytes 8-11 "WEBP".
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
    case PDF_MIME:
      return starts([0x25, 0x50, 0x44, 0x46]);
    case DOCX_MIME:
      // #1195 / #1193: OOXML formats share PK magic bytes; requiring Word's main document
      // entry rejects renamed XLSX/PPTX files before untrusted bytes reach extraction.
      if (!starts([0x50, 0x4b, 0x03, 0x04])) return false;
      try {
        return (await JSZip.loadAsync(bytes)).file("word/document.xml") !== null;
      } catch {
        return false;
      }
    default:
      return true; // text kinds: no signature to check
  }
}

/**
 * Filenames are user input and reach the engine prompt (manifest block) and the UI. Treat
 * as opaque display text: strip control chars, forbid the <> that could open/close framing
 * tags (defense-in-depth next to neutralizeSeedFraming), collapse whitespace, cap length.
 * Never used as a path component — the blob lives under the server-generated UUID.
 */
export function sanitizeAttachmentFileName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001F\u007F<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
  return capped.length > 0 ? capped : "attachment";
}

export interface StoredAttachmentMeta {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly sentAt?: string;
}

/** Upload-validation failure with the HTTP status the route should surface. */
export class ChatAttachmentUploadError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ChatAttachmentUploadError";
  }
}

export type AttachmentContent =
  | { readonly kind: "text"; readonly meta: StoredAttachmentMeta; readonly text: string }
  | { readonly kind: "image"; readonly meta: StoredAttachmentMeta; readonly base64: string }
  | { readonly kind: "missing" };

const ATTACHMENTS_DIR = "attachments";

function metaPath(id: string): string {
  return `${ATTACHMENTS_DIR}/${id}/meta.json`;
}

function blobPath(id: string): string {
  return `${ATTACHMENTS_DIR}/${id}/blob`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function parseMeta(rawJson: string): StoredAttachmentMeta | undefined {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object") return undefined;
    const m = parsed as Record<string, unknown>;
    if (
      typeof m["id"] !== "string" ||
      typeof m["fileName"] !== "string" ||
      typeof m["mimeType"] !== "string" ||
      typeof m["sizeBytes"] !== "number" ||
      typeof m["createdAt"] !== "string"
    ) {
      return undefined;
    }
    return {
      id: m["id"],
      fileName: m["fileName"],
      mimeType: m["mimeType"],
      sizeBytes: m["sizeBytes"],
      createdAt: m["createdAt"],
      ...(typeof m["sentAt"] === "string" ? { sentAt: m["sentAt"] } : {})
    };
  } catch {
    return undefined;
  }
}

async function readMetaInCtx(
  ctx: VaultContext,
  id: string
): Promise<StoredAttachmentMeta | undefined> {
  try {
    return parseMeta(await readVaultFile(ctx, metaPath(id)));
  } catch {
    return undefined; // missing dir/file or corrupt meta both read as "not found"
  }
}

export class ChatAttachmentsService {
  constructor(private readonly vaultRunner: VaultContextRunner) {}

  async saveAttachment(
    access: AccessContext,
    input: { readonly fileName: string; readonly mimeType: string; readonly bytes: Buffer }
  ): Promise<StoredAttachmentMeta> {
    const kind = classifyAttachmentMime(input.mimeType);
    if (!kind) {
      throw new ChatAttachmentUploadError(415, `Unsupported attachment type: ${input.mimeType}`);
    }
    if (input.bytes.length === 0) {
      throw new ChatAttachmentUploadError(400, "Attachment is empty");
    }
    const cap = kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_DOCUMENT_ATTACHMENT_BYTES;
    if (input.bytes.length > cap) {
      throw new ChatAttachmentUploadError(
        413,
        `Attachment exceeds the ${Math.floor(cap / (1024 * 1024))} MB limit for this type`
      );
    }
    if (!(await sniffMatches(input.mimeType, input.bytes))) {
      throw new ChatAttachmentUploadError(
        415,
        "Attachment content does not match its declared type"
      );
    }

    const meta: StoredAttachmentMeta = {
      id: randomUUID(),
      fileName: sanitizeAttachmentFileName(input.fileName),
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      createdAt: new Date().toISOString()
    };

    return this.vaultRunner.withVaultContext(access, async (ctx) => {
      // Lazy GC (spec §6): each upload sweeps this user's stale unsent uploads, so
      // abandoned files disappear without a scheduler or pg-boss job.
      const pending = await this.sweepAndCountPending(ctx);
      if (pending >= MAX_PENDING_ATTACHMENTS) {
        throw new ChatAttachmentUploadError(
          429,
          "Too many unsent attachments. Send or wait before uploading more."
        );
      }
      await writeVaultFileBytes(ctx, blobPath(meta.id), input.bytes);
      await writeVaultFile(ctx, metaPath(meta.id), JSON.stringify(meta));
      return meta;
    });
  }

  async getMeta(access: AccessContext, id: string): Promise<StoredAttachmentMeta | undefined> {
    if (!isAttachmentId(id)) return undefined;
    return this.vaultRunner.withVaultContext(access, (ctx) => readMetaInCtx(ctx, id));
  }

  /** Stamp sentAt so GC never reaps an attachment that made it onto a turn. */
  async markSent(access: AccessContext, ids: readonly string[]): Promise<void> {
    const sentAt = new Date().toISOString();
    await this.vaultRunner.withVaultContext(access, async (ctx) => {
      for (const id of ids) {
        if (!isAttachmentId(id)) continue;
        const meta = await readMetaInCtx(ctx, id);
        if (!meta) continue;
        await writeVaultFile(ctx, metaPath(id), JSON.stringify({ ...meta, sentAt }));
      }
    });
  }

  /** Text is capped at ATTACHMENT_TEXT_CAP_CHARS for module consumers. */
  async readContent(access: AccessContext, id: string): Promise<AttachmentContent> {
    const content = await this.readFullContent(access, id);
    return content.kind === "text" ? { ...content, text: capText(content.text) } : content;
  }

  /** The full extracted text, uncapped. chat.readAttachment pages through it. */
  async readFullContent(access: AccessContext, id: string): Promise<AttachmentContent> {
    if (!isAttachmentId(id)) return { kind: "missing" };
    return this.vaultRunner.withVaultContext(access, async (ctx) => {
      const meta = await readMetaInCtx(ctx, id);
      if (!meta) return { kind: "missing" } as const;
      const mimeKind = classifyAttachmentMime(meta.mimeType);
      let bytes: Buffer;
      try {
        bytes = await readVaultFileBytes(ctx, blobPath(id));
      } catch {
        return { kind: "missing" } as const;
      }
      if (mimeKind === "image") {
        return { kind: "image", meta, base64: bytes.toString("base64") } as const;
      }
      if (mimeKind === "pdf") {
        return { kind: "text", meta, text: await extractPdfText(bytes) } as const;
      }
      if (mimeKind === "docx") {
        return { kind: "text", meta, text: await extractDocxText(bytes) } as const;
      }
      return { kind: "text", meta, text: bytes.toString("utf8") } as const;
    });
  }

  private async sweepAndCountPending(ctx: VaultContext): Promise<number> {
    let dirs;
    try {
      dirs = await listVaultDirectories(ctx, ATTACHMENTS_DIR);
    } catch {
      return 0; // attachments/ not created yet — nothing pending
    }
    const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
    let pending = 0;
    for (const dir of dirs) {
      const meta = await readMetaInCtx(ctx, dir.name);
      if (!meta) {
        // Corrupt/partial upload (e.g. crash between blob and meta writes): reap it.
        await deleteVaultDir(ctx, `${ATTACHMENTS_DIR}/${dir.name}`);
        continue;
      }
      if (meta.sentAt) continue;
      if (Date.parse(meta.createdAt) < cutoff) {
        await deleteVaultDir(ctx, `${ATTACHMENTS_DIR}/${dir.name}`);
      } else {
        pending += 1;
      }
    }
    return pending;
  }
}

function capText(text: string): string {
  if (text.length <= ATTACHMENT_TEXT_CAP_CHARS) return text;
  return `${text.slice(0, ATTACHMENT_TEXT_CAP_CHARS)}\n\n[truncated: attachment text exceeds ${ATTACHMENT_TEXT_CAP_CHARS} characters]`;
}

export async function extractPdfText(bytes: Buffer): Promise<string> {
  try {
    // pdf-parse v2: PDFParse class over pdf.js — pure JS, no native deps (spec §4).
    const { PDFParse } = await import("pdf-parse");
    if (existsSync(PDF_WORKER_URL)) PDFParse.setWorker(PDF_WORKER_URL.href);
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      // Free pdf.js worker resources; destroy() may not exist on future majors.
      const destroy = (parser as { destroy?: () => Promise<void> }).destroy;
      if (typeof destroy === "function") await destroy.call(parser).catch(() => undefined);
    }
  } catch (error) {
    // Explicit failure note instead of a crash — the engine can tell the user (spec §4).
    console.warn(
      "[chat-attachments] PDF text extraction failed:",
      error instanceof Error ? error.message : "Unknown PDF parser error"
    );
    return "[PDF text extraction failed for this attachment]";
  }
}

async function extractDocxText(bytes: Buffer): Promise<string> {
  try {
    // #1195 / #1193: raw text keeps resume content on the same capped, deterministic
    // attachment-manifest path as PDFs without preserving active document formatting.
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value;
  } catch {
    return "[DOCX text extraction failed for this attachment]";
  }
}
