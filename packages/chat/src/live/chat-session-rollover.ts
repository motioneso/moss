import { getSeedBudgetTokens, retainedContextFits } from "./chat-session-launch.js";
import type { ChatSessionManagerDeps } from "./chat-session-ports.js";
import type { EnsureSessionOpts, UserSession } from "./chat-session-provider-identity.js";
import { getSessionBudgetTokens, sessionNeedsRollover } from "./chat-session-usage.js";
import { estimateTokens } from "./recall-seed.js";

export interface SessionRolloverHost {
  readonly deps: Pick<ChatSessionManagerDeps, "persistence">;
  ensureSession(
    actorUserId: string,
    userName: string,
    opts: EnsureSessionOpts & { readonly signal?: AbortSignal },
    surface?: string
  ): Promise<UserSession>;
}

/**
 * Before the next admitted turn, hand an over-budget provider session off to a fresh one
 * for the same owner, conversation and provider. The handoff runs only when an accepted
 * summary exists and it plus every uncovered turn fits a fresh launch; otherwise the healthy
 * session keeps serving and condensing is requested. Returns the session the turn must submit to,
 * and whether the check awaited, after which the caller re-checks stop, privacy and provider.
 */
export async function rollOverSessionIfDue(
  host: SessionRolloverHost,
  input: {
    readonly actorUserId: string;
    readonly userName: string;
    readonly session: UserSession;
    readonly nextTurnText: string;
    readonly signal: AbortSignal;
  }
): Promise<{ readonly session: UserSession; readonly waited: boolean }> {
  const { actorUserId, session } = input;
  const budgetTokens = getSessionBudgetTokens();
  if (session.incognito || session.threadId === null) return { session, waited: false };
  if (!sessionNeedsRollover(session.usage, estimateTokens(input.nextTurnText), budgetTokens)) {
    return { session, waited: false };
  }
  const binding = { threadId: session.threadId };
  const retained = await host.deps.persistence.listPriorTurns(
    actorUserId,
    { ...binding, measureOnly: true },
    session.surface
  );
  // A fresh launch's memory seed may use its whole budget, so check against the worst case.
  const seedBudget = getSeedBudgetTokens();
  const event = {
    threadId: session.threadId,
    sessionTokens: session.usage?.tokens ?? 0,
    budgetTokens,
    summaryTokens: estimateTokens(retained.oldSummary ?? ""),
    replayMessages: retained.recent.length
  };
  // Only an accepted, current summary keeps earlier decisions across the handoff.
  const hasAcceptedSummary = (retained.oldSummary ?? "").trim().length > 0;
  if (!hasAcceptedSummary || !retainedContextFits(seedBudget, retained, seedBudget)) {
    const status = await host.deps.persistence
      .requestConversationSummary?.(actorUserId, binding, session.surface)
      .catch(() => undefined);
    console.info(
      JSON.stringify({ event: "chat.session.rollover_deferred", ...event, summary: status })
    );
    return { session, waited: true };
  }
  input.signal.throwIfAborted();
  console.info(JSON.stringify({ event: "chat.session.rollover", ...event }));
  const next = await host.ensureSession(
    actorUserId,
    input.userName,
    { rollover: session, signal: input.signal },
    session.surface
  );
  // Context seeded into the old session must not be framed again by a remounted caller.
  if (next !== session && next.threadId === session.threadId) {
    for (const key of session.seededContextKeys) next.seededContextKeys.add(key);
  }
  return { session: next, waited: true };
}
