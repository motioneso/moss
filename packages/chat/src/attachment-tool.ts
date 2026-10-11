import { renderToolResult, type ToolExecute } from "@moss/module-sdk";

import type { ChatAttachmentsService } from "./attachments-service.js";

/**
 * #1133 — `chat.readAttachment`: the engine's on-demand pull for a file the user
 * attached to the current turn. The engine learns ids from the server-composed
 * `<attachments>` manifest (see live/attachments-manifest.ts) and fetches bytes here,
 * so attachment content never rides in the prompt text itself.
 *
 * Risk is "read", which structurally routes this through the gateway's
 * readToolServices registry (never write-capable services, no confirmation). Vault
 * ownership is structural — the service resolves ids inside the CALLER's vault only,
 * so another user's id simply comes back "not found". Images return via the
 * `media` pass-through (MCP image content block, bypassing renderAndCap — see
 * gateway.runHandler). PDF/text return extracted text one page at a time (#3342):
 * each page is sized so its rendered result stays under the gateway's 16k render cap.
 */

/** Most characters one page returns before the render check (#3342). */
const PAGE_CHARS_MAX = 12_000;
/** The gateway cuts any tool result whose rendered data passes this (output-validation.ts). */
const GATEWAY_RENDER_CAP_CHARS = 16_000;
/** Most matches one search call returns (#3342). */
const MATCH_LIMIT = 6;
/** Characters of text shown on each side of a match. */
const MATCH_CONTEXT_CHARS = 120;
/** Longest search term kept, so one term cannot crowd out the page. */
const SEARCH_TERM_MAX_CHARS = 100;

export const chatReadAttachmentExecute: ToolExecute = async (_scopedDb, input, ctx, services) => {
  const svc = services?.chatAttachments as ChatAttachmentsService | undefined;
  if (!svc) throw new Error("chat attachments service unavailable");
  const result = await svc.readFullContent(
    { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
    String(input.attachmentId ?? "")
  );
  if (result.kind === "missing") {
    return { data: { error: "Attachment not found" } };
  }
  if (result.kind === "image") {
    return {
      data: { fileName: result.meta.fileName, mimeType: result.meta.mimeType },
      media: { kind: "image", base64: result.base64, mimeType: result.meta.mimeType }
    };
  }
  const meta = { fileName: result.meta.fileName, mimeType: result.meta.mimeType };
  const search = readSearchTerm(input.search);
  if (search !== undefined) {
    return { data: fitSearchPage(meta, result.text, search, readOffset(input.offset)) };
  }
  return {
    data: fitTextPage(meta, result.text, readOffset(input.offset), readLimit(input.limit))
  };
};

interface AttachmentFileMeta {
  readonly fileName: string;
  readonly mimeType: string;
}

function readOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function readLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PAGE_CHARS_MAX;
  return Math.min(Math.max(1, Math.floor(value)), PAGE_CHARS_MAX);
}

/**
 * The largest page, starting at `offset` and no longer than `limit`, whose rendered
 * result fits under the gateway cap. Escaped characters (quotes, newlines) make the
 * rendered result longer than the raw text, so the page can shrink below `limit`.
 */
function fitTextPage(meta: AttachmentFileMeta, text: string, offset: number, limit: number) {
  const fits = (chars: number) =>
    renderToolResult({ data: buildTextPage(meta, text, offset, chars) }).length <=
    GATEWAY_RENDER_CAP_CHARS;
  if (fits(limit)) return buildTextPage(meta, text, offset, limit);
  // `low` always fits (an empty page), `high` does not. Narrow the gap to one character.
  let low = 0;
  let high = limit;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return buildTextPage(meta, text, offset, low);
}

function buildTextPage(meta: AttachmentFileMeta, text: string, offset: number, limit: number) {
  const totalChars = text.length;
  const start = Math.min(offset, totalChars);
  let end = Math.min(totalChars, start + limit);
  // Keep a surrogate pair (an emoji, for example) whole instead of splitting it across pages.
  if (end < totalChars && end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  const nextOffset = end < totalChars ? end : undefined;
  // The reading position comes before the text so it is never buried under a long page.
  return {
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    totalChars,
    offset: start,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    note: pageNote(totalChars, start, end, nextOffset),
    text: text.slice(start, end)
  };
}

function pageNote(
  totalChars: number,
  start: number,
  end: number,
  nextOffset: number | undefined
): string {
  if (start === end) {
    return `Offset ${start} is at or past the end of the ${totalChars}-character file. Nothing more to read.`;
  }
  const range = `Showing characters ${start + 1} to ${end} of ${totalChars}.`;
  return nextOffset === undefined
    ? `${range} That is the end of the file.`
    : `${range} ${totalChars - end} characters remain unread. Call again with offset ${nextOffset} to read on.`;
}

function readSearchTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const term = value.trim().slice(0, SEARCH_TERM_MAX_CHARS);
  return term === "" ? undefined : term;
}

/**
 * The first matches from `offset` onward, fewer when a passage's escaped characters
 * would push the rendered result past the gateway cap.
 */
function fitSearchPage(meta: AttachmentFileMeta, text: string, term: string, offset: number) {
  let shown = MATCH_LIMIT;
  let page = buildSearchPage(meta, text, term, offset, shown);
  while (shown > 1 && renderToolResult({ data: page }).length > GATEWAY_RENDER_CAP_CHARS) {
    shown -= 1;
    page = buildSearchPage(meta, text, term, offset, shown);
  }
  return page;
}

function buildSearchPage(
  meta: AttachmentFileMeta,
  text: string,
  term: string,
  offset: number,
  shown: number
) {
  const pattern = new RegExp(escapeRegExp(term), "gi");
  const allIndexes = [...text.matchAll(pattern)].map((match) => match.index);
  const fromOffset = allIndexes.filter((index) => index >= offset);
  const nextOffset = fromOffset[shown];
  return {
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    totalChars: text.length,
    search: term,
    matchCount: allIndexes.length,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    note: searchNote(text.length, term, offset, fromOffset.length, shown, nextOffset),
    matches: fromOffset.slice(0, shown).map((index) => ({
      offset: index,
      passage: passageAround(text, index, term.length)
    }))
  };
}

function searchNote(
  totalChars: number,
  term: string,
  offset: number,
  remaining: number,
  shown: number,
  nextOffset: number | undefined
): string {
  if (remaining === 0) {
    return offset === 0
      ? `No match for "${term}" in the ${totalChars}-character file. Read the file to the end before saying it is absent.`
      : `No match for "${term}" from offset ${offset} onward, in the ${totalChars}-character file.`;
  }
  const found = `Showing ${shown} ${shown === 1 ? "match" : "matches"} for "${term}" from offset ${offset}.`;
  return nextOffset === undefined
    ? `${found} That is the last of them.`
    : `${found} More remain: call again with offset ${nextOffset} to see them.`;
}

function passageAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - MATCH_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + MATCH_CONTEXT_CHARS);
  return text.slice(start, end);
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
