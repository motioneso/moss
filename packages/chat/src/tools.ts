import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";

import { ChatRepository } from "./repository.js";

const repository = new ChatRepository();

const MAX_TURNS = 40;
const EXCERPT_CHARS = 280;
// Bound the thread scan by REAL activity. NOTE: ChatRepository.listThreads orders by
// `updated_at`, which is NOT bumped on a turn (recordCompletedTurn inserts messages;
// touchThread bumps `last_active_at`, not `updated_at`) — so an `updated_at`-ordered cap
// could drop a thread that was active today but created long ago. This tool therefore
// uses a dedicated `listThreadsByActivity` (ordered by `last_active_at DESC`), so the
// most recently active N threads — which hold all of today's turns — are scanned.
const MAX_THREADS_SCANNED = 20;

/**
 * The tool seam carries no tz input, so it conservatively over-includes the last 36h
 * (covers any IANA offset's "today" without dropping an early-morning turn). The
 * AUTHORITATIVE local-day filter is applied by compose, which DOES know the
 * definition's timezone (see compose `withinLocalDay` on `createdAt`). This window must
 * be wider than any tz offset so compose never sees a turn the tool already dropped.
 */
function startOfTodayUtcWindow(now: Date): Date {
  return new Date(now.getTime() - 36 * 60 * 60 * 1000);
}

export const chatListTodaysTurnsExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);

  // Ordered by last_active_at (bumped on every turn), so a long-lived thread active
  // today is NOT dropped by the scan cap. See MAX_THREADS_SCANNED note above.
  const threads = await repository.listThreadsByActivity(scopedDb, MAX_THREADS_SCANNED);
  const since = startOfTodayUtcWindow(new Date());
  const turns: Array<{ role: string; excerpt: string; threadTitle: string; createdAt: string }> =
    [];

  for (const thread of threads) {
    if (thread.incognito) {
      continue;
    }
    const messages = await repository.listMessages(scopedDb, thread.id);
    for (const message of messages) {
      if (message.status !== "stored") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const createdAt =
        message.created_at instanceof Date ? message.created_at : new Date(message.created_at);
      if (createdAt < since) {
        continue;
      }
      turns.push({
        role: message.role,
        excerpt: message.body.slice(0, EXCERPT_CHARS),
        threadTitle: thread.title,
        createdAt: createdAt.toISOString()
      });
    }
  }

  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Keep the newest turns; the list stays in ascending order.
  return { data: { turns: turns.slice(-MAX_TURNS) } };
};
