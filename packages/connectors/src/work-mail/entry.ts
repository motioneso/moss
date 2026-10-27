import { parseDocument } from "yaml";
import type { CapturedMailMessage, WorkMailAppendResult } from "./types.js";

export function isPrivateWorkMailNote(content: string): boolean {
  if (!/^\uFEFF?---\r?\n/.test(content)) return false;
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (!frontmatter || (frontmatter[1]?.length ?? 0) > 64_000) return true;
  try {
    const document = parseDocument(frontmatter[1] ?? "", { uniqueKeys: true, merge: true });
    if (document.errors.length || document.warnings.length) return true;
    const data: unknown = document.toJS({ maxAliasCount: 20 });
    if (typeof data !== "object" || data === null || Array.isArray(data)) return true;
    return "private" in data && data.private !== false;
  } catch {
    return true;
  }
}

function sourceText(value: string): string {
  return Array.from(value.slice(0, 500))
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127 || point === 0x2028 || point === 0x2029 ? " " : character;
    })
    .join("");
}

export function formatWorkMailEntry(
  message: CapturedMailMessage,
  entry: string,
  now: Date
): string {
  return (
    `\n\n## ${now.toISOString().slice(0, 10)} — Work mail\n\n` +
    `From: ${sourceText(message.sender)}\n` +
    `Subject: ${sourceText(message.subject)}\n` +
    `Received: ${new Date(message.receivedAt).toISOString()}\n\n${entry.trim()}\n`
  );
}

export async function appendOnlyWorkMailWrite(
  original: string,
  proposed: string,
  append: (suffix: string, expected: string) => Promise<WorkMailAppendResult>
): Promise<WorkMailAppendResult> {
  if (!proposed.startsWith(original)) return "changed";
  return append(proposed.slice(original.length), original);
}
