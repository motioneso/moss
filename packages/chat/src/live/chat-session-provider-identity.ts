import type { ProviderKind } from "@moss/ai";

import type { ChatPersistencePort } from "./chat-session-ports.js";
import {
  DEFAULT_CHAT_SURFACE,
  normalizeChatSurface,
  surfaceSessionKey,
  type ChatSurface
} from "./chat-surface.js";
import { getPinnedThreadState, getSelectedThreadState } from "./chat-thread-selection.js";
import {
  ApiKeyLiveChatUnavailableError,
  CHAT_CHANGED_WHILE_STARTING_MESSAGE,
  ChatProviderChangedError,
  CliChatUnavailableError,
  UnsupportedLegacyCliProviderError
} from "./errors.js";
import type { SessionUsageMeter } from "./chat-session-usage.js";
import type { CliChatEngine } from "./types.js";

export type ActiveChatProvider = Awaited<ReturnType<ChatPersistencePort["resolveActiveProvider"]>>;

export interface UserSession {
  actorUserId: string;
  surface: ChatSurface;
  /** Conversation captured at launch; never follows the actor’s current-thread pointer. */
  readonly threadId: string | null;
  engine: CliChatEngine;
  provider: ProviderKind;
  model: string;
  providerIdentity: ActiveChatProvider;
  lastActivity: number;
  transcriptOffset: number;
  incognito: boolean;
  readonly seededContextKeys: Set<string>;
  readonly mcpToken?: string;
  readonly startsToolClientPerTurn: boolean;
  /** App-side count of what this provider session was fed and produced. */
  readonly usage: SessionUsageMeter;
}

export function sameActiveChatProvider(
  left: ActiveChatProvider,
  right: ActiveChatProvider
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.providerConfigId === right.providerConfigId &&
    left.authMethod === right.authMethod &&
    left.acpAgentId === right.acpAgentId &&
    left.acpModel === right.acpModel
  );
}

export async function assertProviderIdentityForPendingTurn(
  expected: ActiveChatProvider,
  current: ActiveChatProvider | Promise<ActiveChatProvider>
): Promise<void> {
  if (!sameActiveChatProvider(expected, await current)) throw new ChatProviderChangedError();
}

export class ActiveProviderChangedDuringLaunchError extends Error {}

export function assertLiveCliProvider(provider: ActiveChatProvider): void {
  if (provider.authMethod === "api_key") throw new ApiKeyLiveChatUnavailableError();
  if (provider.authMethod === "cli" && !provider.acpAgentId) {
    throw new UnsupportedLegacyCliProviderError();
  }
}

export async function discardChatSession(
  sessionKey: string,
  session: UserSession,
  sessions: Map<string, UserSession>,
  revokeMcpToken?: (sessionKey: string) => void
): Promise<void> {
  await session.engine.kill();
  if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
  revokeMcpToken?.(sessionKey);
}

export async function switchChatProviderSession(input: {
  readonly actorUserId: string;
  readonly userName: string;
  readonly surface?: string;
  readonly sessions: ReadonlyMap<string, UserSession>;
  readonly discardSession: (sessionKey: string, session: UserSession) => Promise<void>;
  readonly ensureSession: (
    actorUserId: string,
    userName: string,
    opts?: { readonly forceReplay?: boolean },
    surface?: string
  ) => Promise<UserSession>;
}): Promise<void> {
  const surface = normalizeChatSurface(input.surface);
  const sessionKey = surfaceSessionKey(input.actorUserId, surface);
  const session = input.sessions.get(sessionKey);
  if (session) await input.discardSession(sessionKey, session);
  await input.ensureSession(
    input.actorUserId,
    input.userName,
    session ? { forceReplay: true } : undefined,
    surface
  );
}

export async function dropSessionsForProvider(input: {
  readonly provider: ProviderKind;
  readonly sessions: Map<string, UserSession>;
  readonly revokeMcpToken?: (sessionKey: string) => void;
}): Promise<void> {
  for (const [sessionKey, session] of input.sessions) {
    if (session.provider !== input.provider) continue;
    try {
      await session.engine.kill();
    } catch {
      // A failed kill must not strand the session; drop it and let the next turn launch fresh.
    }
    input.sessions.delete(sessionKey);
    input.revokeMcpToken?.(sessionKey);
  }
}

export interface EnsureSessionOpts {
  readonly forceReplay?: boolean;
  /** Replace exactly this healthy session with a fresh one bound to the same conversation. */
  readonly rollover?: UserSession;
}

export interface LaunchSessionOpts {
  readonly forceReplay: boolean;
  /** Bind the launch to this conversation, refusing if it is no longer selected. */
  readonly pinThreadId?: string;
}

export async function ensureSessionForCurrentProvider(input: {
  readonly actorUserId: string;
  readonly userName: string;
  readonly opts: EnsureSessionOpts | undefined;
  readonly surface: ChatSurface;
  readonly sessionKey: string;
  readonly launching: Map<string, Promise<UserSession>>;
  readonly persistence: Pick<
    ChatPersistencePort,
    "resolveActiveProvider" | "getCurrentThreadState" | "getMainThreadState"
  >;
  readonly sessions: ReadonlyMap<string, UserSession>;
  readonly pendingForcedReplay: Set<string>;
  readonly waitForSelection: () => Promise<void>;
  readonly discardSession: (session: UserSession) => Promise<void>;
  readonly launchSession: (
    opts: LaunchSessionOpts,
    providerIdentity: ActiveChatProvider
  ) => Promise<UserSession>;
}): Promise<UserSession> {
  const inFlight = input.launching.get(input.sessionKey);
  if (inFlight) {
    await inFlight;
    return ensureSessionForCurrentProvider(input);
  }

  const ensure = resolveSessionForCurrentProvider(input);
  const tracked = ensure.finally(() => {
    if (input.launching.get(input.sessionKey) === tracked) {
      input.launching.delete(input.sessionKey);
    }
  });
  input.launching.set(input.sessionKey, tracked);
  return tracked;
}

async function resolveSessionForCurrentProvider(input: {
  readonly actorUserId: string;
  readonly userName: string;
  readonly opts: EnsureSessionOpts | undefined;
  readonly surface: ChatSurface;
  readonly sessionKey: string;
  readonly persistence: Pick<
    ChatPersistencePort,
    "resolveActiveProvider" | "getCurrentThreadState" | "getMainThreadState"
  >;
  readonly sessions: ReadonlyMap<string, UserSession>;
  readonly pendingForcedReplay: Set<string>;
  readonly waitForSelection: () => Promise<void>;
  readonly discardSession: (session: UserSession) => Promise<void>;
  readonly launchSession: (
    opts: LaunchSessionOpts,
    providerIdentity: ActiveChatProvider
  ) => Promise<UserSession>;
}): Promise<UserSession> {
  let forceReplay = input.opts?.forceReplay ?? input.pendingForcedReplay.has(input.sessionKey);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.waitForSelection();
    forceReplay ||= input.pendingForcedReplay.has(input.sessionKey);
    const providerIdentity = await input.persistence.resolveActiveProvider(input.actorUserId);
    const existing = input.sessions.get(input.sessionKey);
    const rollover = attempt === 0 ? input.opts?.rollover : undefined;
    const sameProvider =
      existing !== undefined && sameActiveChatProvider(existing.providerIdentity, providerIdentity);
    // A rollover replaces only its exact session, unchanged provider, still-selected conversation.
    const pinThreadId =
      rollover && existing === rollover && sameProvider && rollover.threadId !== null
        ? ((await rolloverStillSelected(input, rollover)) ?? undefined)
        : undefined;
    if (existing && (rollover ? pinThreadId === undefined : sameProvider)) return existing;

    if (existing) {
      await input.discardSession(existing);
      forceReplay = true;
    }

    let session: UserSession;
    try {
      session = await input.launchSession(
        pinThreadId ? { forceReplay: true, pinThreadId } : { forceReplay },
        providerIdentity
      );
    } catch (error) {
      if (pinThreadId || !(error instanceof ActiveProviderChangedDuringLaunchError)) throw error;
      forceReplay = true;
      continue;
    }
    try {
      const providerAfterLaunch = await input.persistence.resolveActiveProvider(input.actorUserId);
      const conversationMatches = pinThreadId
        ? session.threadId === pinThreadId &&
          (await rolloverStillSelected(input, session)) === pinThreadId
        : await sessionMatchesCurrentConversation(
            input,
            session,
            !forceReplay && !input.pendingForcedReplay.has(input.sessionKey)
          );
      if (
        sameActiveChatProvider(session.providerIdentity, providerAfterLaunch) &&
        conversationMatches &&
        input.sessions.get(input.sessionKey) === session
      ) {
        input.pendingForcedReplay.delete(input.sessionKey);
        return session;
      }
    } catch (error) {
      await input.discardSession(session);
      throw error;
    }
    await input.discardSession(session);
    // A late rollover launch never retries into whatever conversation is selected now.
    if (pinThreadId) break;
    forceReplay = true;
  }

  throw new CliChatUnavailableError(CHAT_CHANGED_WHILE_STARTING_MESSAGE);
}

/** The session's conversation id while it is still selected with the same privacy, else null. */
async function rolloverStillSelected(
  input: {
    readonly actorUserId: string;
    readonly surface: ChatSurface;
    readonly persistence: Pick<ChatPersistencePort, "getCurrentThreadState" | "getMainThreadState">;
  },
  session: UserSession
): Promise<string | null> {
  if (session.threadId === null) return null;
  const pinned = await getPinnedThreadState({
    actorUserId: input.actorUserId,
    surface: input.surface,
    threadId: session.threadId,
    persistence: input.persistence
  });
  return pinned && pinned.incognito === session.incognito ? pinned.id : null;
}

async function sessionMatchesCurrentConversation(
  input: {
    readonly actorUserId: string;
    readonly surface: ChatSurface;
    readonly persistence: Pick<ChatPersistencePort, "getCurrentThreadState" | "getMainThreadState">;
  },
  session: UserSession,
  preferMain: boolean
): Promise<boolean> {
  const current = await getSelectedThreadState({
    actorUserId: input.actorUserId,
    surface: input.surface,
    useMain: preferMain && input.surface === DEFAULT_CHAT_SURFACE,
    persistence: input.persistence
  });
  // A stream pre-start can finish after a clear/resume removed the old session. Its frozen
  // origin remains correct for that engine, but it must never become the new conversation's engine.
  return (
    session.threadId === (current?.id ?? null) &&
    session.incognito === (current?.incognito ?? false)
  );
}

export async function assertProviderIdentityBeforeReplay(input: {
  readonly actorUserId: string;
  readonly sessionKey: string;
  readonly providerIdentity: ActiveChatProvider;
  readonly persistence: Pick<ChatPersistencePort, "resolveActiveProvider">;
  readonly engine: CliChatEngine;
  readonly revokeMcpToken?: (sessionKey: string) => void;
}): Promise<void> {
  let currentProvider: ActiveChatProvider;
  try {
    currentProvider = await input.persistence.resolveActiveProvider(input.actorUserId);
  } catch (error) {
    await discardUnlaunchedEngine(input.engine, input.sessionKey, input.revokeMcpToken);
    throw error;
  }
  if (sameActiveChatProvider(input.providerIdentity, currentProvider)) return;

  await discardUnlaunchedEngine(input.engine, input.sessionKey, input.revokeMcpToken);
  throw new ActiveProviderChangedDuringLaunchError();
}

async function discardUnlaunchedEngine(
  engine: CliChatEngine,
  sessionKey: string,
  revokeMcpToken?: (sessionKey: string) => void
): Promise<void> {
  try {
    await engine.kill();
  } catch {
    // The engine has not launched yet; best-effort cleanup before replay is submitted.
  }
  revokeMcpToken?.(sessionKey);
}
