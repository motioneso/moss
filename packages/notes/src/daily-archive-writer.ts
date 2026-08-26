import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DataContextDb } from "@moss/db";
import { formatInZone, validateChatArchiveFolder } from "@moss/shared";

import {
  assertInside,
  recheckInside,
  resolveSource,
  type NotesSyncToolService
} from "./write-tools.js";

const ARCHIVE_MARKER = "<!-- moss-chat-archive:v1 -->";

export interface ChatArchiveMessage {
  readonly role: "user" | "assistant";
  readonly body: string;
  readonly createdAt: string;
}

export interface ChatArchiveSession {
  readonly threadId: string;
  readonly title: string;
  readonly messages: readonly ChatArchiveMessage[];
}

export interface WriteDailyChatArchiveResult {
  readonly written: boolean;
  readonly path: string | null;
  readonly reason?: "no-notes-source" | "no-sessions" | "bad-folder";
}

/** Thrown when today's file and its fallback both already exist and neither was written by chat archiving. */
export class ChatArchiveConflictError extends Error {}

export async function writeDailyChatArchive(
  scopedDb: DataContextDb,
  actorUserId: string,
  localDate: string,
  folder: string,
  sessions: readonly ChatArchiveSession[],
  timezone: string,
  notesSync: NotesSyncToolService
): Promise<WriteDailyChatArchiveResult> {
  if (sessions.length === 0) {
    return { written: false, path: null, reason: "no-sessions" };
  }

  let validatedFolder: string;
  try {
    validatedFolder = validateChatArchiveFolder(folder);
  } catch {
    return { written: false, path: null, reason: "bad-folder" };
  }

  let root: string;
  try {
    root = await resolveSource(scopedDb);
  } catch {
    return { written: false, path: null, reason: "no-notes-source" };
  }

  const primaryRel = join(validatedFolder, `${localDate}.md`);
  const fallbackRel = join(validatedFolder, `${localDate} (moss).md`);

  const targetRel = (await isMossFileOrAbsent(root, primaryRel))
    ? primaryRel
    : (await isMossFileOrAbsent(root, fallbackRel))
      ? fallbackRel
      : null;

  if (targetRel === null) {
    throw new ChatArchiveConflictError(
      `Both ${primaryRel} and ${fallbackRel} are occupied by files not written by the chat archive`
    );
  }

  const content = renderMarkdown(sessions, timezone);
  const file = join(root, targetRel);
  await mkdir(dirname(file), { recursive: true });
  assertInside(root, file);
  await recheckInside(root, file);
  await writeFile(file, content, "utf-8");
  await notesSync.enqueue(actorUserId, root);

  return { written: true, path: targetRel };
}

async function isMossFileOrAbsent(root: string, rel: string): Promise<boolean> {
  const file = join(root, rel);
  let existing: string;
  try {
    existing = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  return existing.split("\n", 1)[0] === ARCHIVE_MARKER;
}

function renderMarkdown(sessions: readonly ChatArchiveSession[], timezone: string): string {
  const lines: string[] = [ARCHIVE_MARKER, ""];
  for (const session of sessions) {
    lines.push(sessionHeading(session, timezone), "");
    for (const message of session.messages) {
      lines.push(`**${message.role}:** ${message.body}`, "");
    }
  }
  return lines.join("\n");
}

function sessionHeading(session: ChatArchiveSession, timezone: string): string {
  const first = session.messages[0];
  const time = first
    ? formatInZone(first.createdAt, timezone, { hour: "numeric", minute: "2-digit" })
    : session.threadId;
  const title = session.title.trim();
  return title.length > 0 ? `## ${time} — ${title}` : `## ${time}`;
}
