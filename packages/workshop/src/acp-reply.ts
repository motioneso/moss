import type { AccessContext, DataContextRunner } from "@moss/db";
import type { WorkshopFeedEntry, WorkshopProject } from "@moss/shared";

import { WorkshopProjectFeed } from "./project-feed.js";
import { PROJECT_REPLY_PERSONA_TEXT } from "./project-reply.js";
import type { ProjectReplyResult } from "./project-reply.js";

/** One prompt turn against the outside agent; close ends it and revokes access. */
export interface WorkshopAcpTurn {
  prompt(text: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Opens one outside-agent turn for a Workshop project. Implemented
 * composition-side (where the runner connection and tool-server mint live);
 * this package only drives it. Absent means the outside agent is not wired.
 */
export interface WorkshopAcpOpener {
  open(input: {
    sessionKey: string;
    projectId: string;
    actorUserId: string;
  }): Promise<WorkshopAcpTurn>;
}

export interface AcpReplyDependencies {
  readonly dataContext: DataContextRunner;
  readonly opener: WorkshopAcpOpener;
}

/**
 * What the outside agent may do in a Workshop turn, past the persona. Short
 * on purpose: the persona plus these two sentences are the whole guidance.
 */
export const ACP_BUILD_GUIDANCE_TEXT =
  "You can run build commands with the workshop run command tool. " +
  "Each command needs the owner's approval on a card. " +
  "Say what you ran and what it showed.";

/** Session key shared with the run-command tool's project parser. */
export function workshopSessionKey(userId: string, projectId: string): string {
  return `workshop:${userId}:${projectId}`;
}

/** Feed entries kept for the replay, oldest first. */
const ACP_HISTORY_ENTRY_LIMIT = 20;
/** Replay budget: past it the oldest entries drop, newest kept. */
const ACP_HISTORY_CHAR_BUDGET = 8000;

function formatHistoryEntry(entry: WorkshopFeedEntry): string {
  const speaker = entry.kind === "assistant_message" ? "Moss" : "Owner";
  return `${speaker}: ${entry.text}`;
}

function replayHistory(entries: readonly WorkshopFeedEntry[]): string[] {
  const lines = entries.map(formatHistoryEntry);
  let chars = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (kept.length > 0 && chars + line.length > ACP_HISTORY_CHAR_BUDGET) break;
    kept.unshift(line);
    chars += line.length;
  }
  return kept;
}

/** The one prompt: persona, build guidance, project, replayed history, message. */
export function buildAcpPrompt(
  project: WorkshopProject,
  userEntry: WorkshopFeedEntry,
  entries: readonly WorkshopFeedEntry[]
): string {
  const lines = [
    PROJECT_REPLY_PERSONA_TEXT,
    ACP_BUILD_GUIDANCE_TEXT,
    `Project title: ${project.title}`,
    `Initial request: ${project.initialRequest}`
  ];
  if (project.context.trim()) lines.push(`Additional context: ${project.context}`);
  const history = replayHistory(entries.slice(-ACP_HISTORY_ENTRY_LIMIT));
  if (history.length > 0) lines.push("", "Earlier in this project:", ...history);
  lines.push("", userEntry.text);
  return lines.join("\n");
}

/**
 * Answers a just-saved project message through the outside agent. History
 * replays from the stored feed and the answer persists the same way today's
 * does. Throws like any helper; the caller keeps the never-throws contract.
 */
export async function attemptAcpProjectReply(
  deps: AcpReplyDependencies,
  access: AccessContext,
  project: WorkshopProject,
  userEntry: WorkshopFeedEntry
): Promise<ProjectReplyResult> {
  const sessionKey = workshopSessionKey(access.actorUserId, project.id);
  const feed = await deps.dataContext.withDataContext(access, (scopedDb) =>
    new WorkshopProjectFeed().list(scopedDb, project.id, { limit: ACP_HISTORY_ENTRY_LIMIT })
  );
  const prompt = buildAcpPrompt(project, userEntry, feed?.entries ?? []);
  const turn = await deps.opener.open({
    sessionKey,
    projectId: project.id,
    actorUserId: access.actorUserId
  });
  try {
    const replyText = await turn.prompt(prompt);
    if (!replyText.trim()) return { delivered: false };
    const written = await deps.dataContext.withDataContext(access, (scopedDb) =>
      new WorkshopProjectFeed().appendAssistantReply(
        scopedDb,
        project.id,
        replyText,
        userEntry.messageId
      )
    );
    if (!written) return { delivered: false };
    return { delivered: true, assistantEntry: written.entry };
  } finally {
    await turn.close().catch((error: unknown) => {
      console.warn(
        `[workshop] project ${project.id} outside-agent turn close failed: ${(error as Error).message}`
      );
    });
  }
}
