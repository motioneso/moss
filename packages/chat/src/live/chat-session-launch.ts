import {
  admissionForActor,
  admitToContext,
  admitOutsideAgentLaunch,
  submitAdmittedContext,
  type AdmittedContext
} from "./context-admission.js";
import { resolveMossEnv } from "@moss/db";

import { renderReplayBlock, renderSummaryBlock } from "./chat-context-blocks.js";
import {
  assertLiveCliProvider,
  assertProviderIdentityBeforeReplay,
  type ActiveChatProvider,
  type LaunchSessionOpts,
  type UserSession
} from "./chat-session-provider-identity.js";
import {
  createSessionUsage,
  noteSessionOutput,
  noteSessionSubmission
} from "./chat-session-usage.js";
import {
  DEFAULT_CHAT_SURFACE,
  normalizeChatSurface,
  surfaceSessionKey,
  type ChatSurface
} from "./chat-surface.js";
import type { ChatSessionManagerDeps } from "./chat-session-ports.js";
import { CHAT_CHANGED_WHILE_STARTING_MESSAGE, CliChatUnavailableError } from "./errors.js";
import { renderPersona } from "./persona.js";
import { estimateTokens, renderMemorySeedBlock } from "./recall-seed.js";
import { getReplayTokenCap, SUMMARY_TOKEN_CAP } from "./replay-window.js";
import {
  CONVERSATION_COULD_NOT_CONDENSE_MESSAGE,
  CONVERSATION_NEEDS_SUMMARY_MODEL_MESSAGE,
  CONVERSATION_TOO_LONG_TO_RESUME_MESSAGE,
  coverageTurnTokens,
  launchContextFits
} from "./summary-coverage.js";
import { drainEngine } from "./session-runtime-helpers.js";
import {
  getPinnedThreadState,
  getSelectedThreadState,
  usesMainThreadSelection
} from "./chat-thread-selection.js";

export interface LaunchChatSessionArgs {
  readonly actorUserId: string;
  readonly userName: string;
  readonly opts: Partial<LaunchSessionOpts> | undefined;
  readonly surface: ChatSurface;
  readonly providerIdentity: ActiveChatProvider;
  readonly deps: ChatSessionManagerDeps;
  readonly sessions: Map<string, UserSession>;
  readonly sequenceBySession: Map<string, number>;
  readonly serverOwnsDrain: boolean;
  readonly pollMs: number;
}

const DEFAULT_SEED_BUDGET_TOKENS = 1500;

export function getSeedBudgetTokens(): number {
  const raw = resolveMossEnv(process.env, "JARVIS_CHAT_SEED_BUDGET_TOKENS");
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEED_BUDGET_TOKENS;
}

/** True when a fresh launch can replay this summary and these uncovered turns untruncated. */
export function retainedContextFits(
  seedTokens: number,
  retained: {
    readonly oldSummary: string | null;
    readonly recent: readonly { role: "user" | "assistant"; content: string }[];
  },
  seedBudget: number = getSeedBudgetTokens()
): boolean {
  return launchContextFits(
    {
      seedTokens,
      summaryTokens: estimateTokens(retained.oldSummary ?? ""),
      replayTokens: retained.recent.reduce((sum, turn) => sum + coverageTurnTokens(turn), 0)
    },
    seedBudget + SUMMARY_TOKEN_CAP + getReplayTokenCap()
  );
}

export async function launchChatSession(args: LaunchChatSessionArgs): Promise<UserSession> {
  const {
    actorUserId,
    userName,
    opts,
    surface,
    providerIdentity,
    deps,
    sessions,
    sequenceBySession,
    serverOwnsDrain,
    pollMs
  } = args;
  const sessionKey = surfaceSessionKey(actorUserId, surface);
  const { provider, model, acpModel, providerConfigId, acpAgentId } = providerIdentity;
  assertLiveCliProvider(providerIdentity);
  const useMain = usesMainThreadSelection({
    surface,
    forceReplay: opts?.forceReplay ?? false
  });
  const pinThreadId = opts?.pinThreadId;
  let threadState = pinThreadId
    ? await getPinnedThreadState({
        actorUserId,
        surface,
        threadId: pinThreadId,
        persistence: deps.persistence
      })
    : await getSelectedThreadState({
        actorUserId,
        surface,
        useMain,
        persistence: deps.persistence
      });
  if (pinThreadId && !threadState) {
    throw new CliChatUnavailableError(CHAT_CHANGED_WHILE_STARTING_MESSAGE);
  }
  if (!threadState && deps.persistence.getCurrentThreadState) {
    await deps.persistence.openNewConversation(actorUserId, undefined, surface);
    threadState = await getSelectedThreadState({
      actorUserId,
      surface,
      useMain,
      persistence: deps.persistence
    });
  }
  // Bind once, before persona or tool-menu awaits can overlap a conversation switch.
  const threadId = threadState?.id ?? null;
  const persona =
    typeof deps.persona === "string"
      ? deps.persona
      : await deps.persona(actorUserId, userName, surface);
  const { neutralDir, personaPath } = await renderPersona(deps.personaFs, {
    sessionKey,
    userName,
    provider,
    baseDir: deps.neutralBase,
    persona
  });
  const mcpConfig = await deps.mintMcpToken?.(actorUserId, sessionKey, threadId);
  if (!sequenceBySession.has(sessionKey)) sequenceBySession.set(sessionKey, 0);
  const nextSequence = () => {
    const next = (sequenceBySession.get(sessionKey) ?? 0) + 1;
    sequenceBySession.set(sessionKey, next);
    return next;
  };
  const engine = await deps.engineFactory(provider, sessionKey, {
    providerConfigId,
    acpAgentId,
    ...(acpModel ? { acpModel } : {}),
    ...(threadId ? { conversationId: threadId, userId: actorUserId } : {}),
    ...(mcpConfig?.token && deps.acpPermissionDeciderForToken
      ? { acpPermissionDecider: deps.acpPermissionDeciderForToken(mcpConfig.token) }
      : {}),
    nextSequence
  });
  await assertProviderIdentityBeforeReplay({
    actorUserId,
    sessionKey,
    providerIdentity,
    persistence: deps.persistence,
    engine,
    revokeMcpToken: deps.revokeMcpToken
  });
  let memorySeed: AdmittedContext | null;
  const seedBudget = getSeedBudgetTokens();
  try {
    if (engine.admitsOutsideContentWithoutPermission) {
      await admitOutsideAgentLaunch(
        admissionForActor(deps.conversationProvenance, actorUserId),
        threadId
      );
    }
    // Rebuild replay from live state for every launch; recall precedes conversation replay.
    const recallResult = deps.recall ? await deps.recall.recall(actorUserId) : null;
    memorySeed = await admitToContext(
      admissionForActor(deps.conversationProvenance, actorUserId),
      threadId,
      "launch_memory_seed",
      recallResult
        ? renderMemorySeedBlock(recallResult.episodicChunks, recallResult.facts, seedBudget)
        : ""
    );
  } catch (error) {
    deps.revokeMcpToken?.(sessionKey);
    await engine.kill().catch(() => undefined);
    throw error;
  }
  const { recent: recentTurns, oldSummary } = await deps.persistence.listPriorTurns(
    actorUserId,
    { forceReplay: opts?.forceReplay, threadId },
    surface
  );
  if (threadState?.incognito && surface !== DEFAULT_CHAT_SURFACE) {
    throw new CliChatUnavailableError("private chat is only available in the drawer");
  }
  if (threadState?.incognito && !engine.purgeTranscripts && !engine.handlesOwnPrivatePurge) {
    throw new CliChatUnavailableError("private session unavailable");
  }
  // The replay is never truncated. Retained context that cannot fit refuses the launch and asks
  // for the older turns to be condensed, so a later resume fits.
  const fits = retainedContextFits(
    estimateTokens(memorySeed?.text ?? ""),
    { oldSummary, recent: recentTurns },
    seedBudget
  );
  if (!fits) {
    const status = await deps.persistence
      .requestConversationSummary?.(actorUserId, { threadId }, surface)
      .catch(() => undefined);
    await engine.kill().catch(() => undefined);
    deps.revokeMcpToken?.(sessionKey);
    throw new CliChatUnavailableError(
      status === "queued"
        ? CONVERSATION_TOO_LONG_TO_RESUME_MESSAGE
        : status === "no_route"
          ? CONVERSATION_NEEDS_SUMMARY_MODEL_MESSAGE
          : CONVERSATION_COULD_NOT_CONDENSE_MESSAGE
    );
  }
  const replayParts: string[] = [];
  if (memorySeed) replayParts.push(memorySeed.text);
  if (oldSummary) replayParts.push(renderSummaryBlock(oldSummary));
  if (recentTurns.length > 0) replayParts.push(renderReplayBlock(recentTurns));
  const replayBatch = replayParts.length > 0 ? replayParts.join("\n\n") : undefined;
  const { offset } = await engine.launch({
    neutralDir,
    personaPath,
    personaText: persona,
    replayBatch,
    // #367: launch builders emit `--model` only for a concrete settings override; the
    // `"default"` sentinel omits it so the CLI rides its own interactive/account model.
    model,
    ...(acpModel ? { acpModel } : {}),
    mcpToken: mcpConfig?.token,
    mcpServerUrl: mcpConfig?.mcpServerUrl
  });

  const startsToolClientPerTurn = engine.startsToolClientPerTurn ?? false;
  if (mcpConfig?.token && !startsToolClientPerTurn) {
    const toolsListReady = await deps.waitForToolsListReady?.(mcpConfig.token);
    if (toolsListReady === false) {
      // The engine process this launch just started, and the token just minted for it, would
      // otherwise leak: nothing else tracks or reaps either once this throw unwinds the launch.
      try {
        await engine.kill();
      } catch {
        // Best-effort teardown of a process that never finished starting up.
      }
      deps.revokeMcpToken?.(sessionKey);
      throw new CliChatUnavailableError("tools list was not ready in time");
    }
  }

  const session: UserSession = {
    actorUserId,
    surface,
    threadId,
    engine,
    provider,
    model,
    providerIdentity,
    lastActivity: deps.clock.now(),
    transcriptOffset: offset,
    incognito: threadState?.incognito ?? false,
    seededContextKeys: new Set(),
    mcpToken: mcpConfig?.token,
    startsToolClientPerTurn,
    usage: createSessionUsage([persona, replayBatch ?? ""])
  };
  sessions.set(sessionKey, session);

  // #342 — only in-process engines need manager-owned replay submit + drain.
  if (replayBatch !== undefined && !serverOwnsDrain) {
    await engine.submit(replayBatch);
    // Drain so real turn records start from a clean offset. The replies still count.
    session.transcriptOffset = await drainEngine(engine, session.transcriptOffset, pollMs, (r) =>
      noteSessionOutput(session.usage, r)
    );
  }

  return session;
}

export interface SeedChatContextArgs {
  readonly actorUserId: string;
  readonly userName: string;
  readonly seed: string;
  readonly idempotencyKey?: string;
  readonly admissionPath?: "seed_route" | "evening_seed";
  readonly surface?: string;
  readonly deps: ChatSessionManagerDeps;
  readonly ensureSession: (
    actorUserId: string,
    userName: string,
    opts: { readonly forceReplay?: boolean } | undefined,
    surface: ChatSurface
  ) => Promise<UserSession>;
  readonly pollMs: number;
}

/**
 * #2956 (ruling R3): seeding submits model input outside any turn, so it
 * sets no turn id. A tool call the seed triggers while a live turn runs on
 * this session is filed under that turn. Seeding normally runs at session
 * start, before any turn, so the overlap needs a seed racing a message —
 * rare enough to document, not to refuse the seed over.
 */
export async function seedChatContext(args: SeedChatContextArgs): Promise<void> {
  const { actorUserId, userName, seed, idempotencyKey, surface, deps, ensureSession, pollMs } =
    args;
  const chatSurface = normalizeChatSurface(surface);
  const sessionKey = surfaceSessionKey(actorUserId, chatSurface);
  const session = await ensureSession(actorUserId, userName, undefined, chatSurface);
  if (idempotencyKey && session.seededContextKeys.has(idempotencyKey)) return;
  const admitted = await admitToContext(
    admissionForActor(deps.conversationProvenance, actorUserId),
    session.threadId,
    args.admissionPath ?? "seed_route",
    seed
  );
  if (!admitted) return;
  await submitAdmittedContext(session.engine, admitted);
  noteSessionSubmission(session.usage, admitted.text, "context");
  session.transcriptOffset = await drainEngine(
    session.engine,
    session.transcriptOffset,
    pollMs,
    (r) => noteSessionOutput(session.usage, r)
  );
  if (idempotencyKey) session.seededContextKeys.add(idempotencyKey);
  session.lastActivity = deps.clock.now();
  deps.touchMcpToken?.(sessionKey);
}
