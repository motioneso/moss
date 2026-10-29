import { join } from "node:path";

import type { DataContextDb } from "@moss/db";
import { formatLocaleTime, validateChatArchiveFolder, type LocaleSettingsDto } from "@moss/shared";

import { mutateVaultFiles } from "@moss/vault";

import { resolveSource, type NotesSyncToolService } from "./write-tools.js";
import { withNotesVault } from "./notes-vault-context.js";

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
  locale: LocaleSettingsDto,
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

  const content = renderMarkdown(sessions, locale);
  const targetRel = await withNotesVault(scopedDb, root, (vault) =>
    mutateVaultFiles(scopedDb, vault, [primaryRel, fallbackRel], async (current) => {
      const destination = current.find(
        ({ content }) => content === null || content.split("\n", 1)[0] === ARCHIVE_MARKER
      );
      if (!destination) {
        throw new ChatArchiveConflictError(
          `Both ${primaryRel} and ${fallbackRel} are occupied by files not written by the chat archive`
        );
      }
      return { changes: [{ path: destination.path, content }], result: destination.path };
    })
  );
  await notesSync.enqueue(actorUserId, root);
  return { written: true, path: targetRel };
}

function renderMarkdown(
  sessions: readonly ChatArchiveSession[],
  locale: LocaleSettingsDto
): string {
  const lines: string[] = [ARCHIVE_MARKER, ""];
  for (const session of sessions) {
    lines.push(sessionHeading(session, locale), "");
    for (const message of session.messages) {
      lines.push(`**${message.role}:** ${message.body}`, "");
    }
  }
  return lines.join("\n");
}

function sessionHeading(session: ChatArchiveSession, locale: LocaleSettingsDto): string {
  const first = session.messages[0];
  const time = first ? formatLocaleTime(first.createdAt, locale) : session.threadId;
  const title = session.title.trim();
  return title.length > 0 ? `## ${time} — ${title}` : `## ${time}`;
}
