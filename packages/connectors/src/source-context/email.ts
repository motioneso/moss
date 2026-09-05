import type { DataContextDb, EmailMessage } from "@moss/db";

import type { ConnectorAccountSafeRow } from "../repository.js";
import type { EmailReadProvider } from "../email-read-provider.js";
import { GMAIL_READ_FOLDER } from "../email-read-provider.js";
import { IMAP_DEFAULT_FOLDER } from "../imap-email-read-provider.js";
import type { ImapConnectionSecret } from "../imap-secret.js";
import { buildEmailActionLink } from "./email-action-links.js";
import {
  extractEmailSignals,
  looksLikeOneTimeCodeEmail,
  type EmailExtractDeps,
  type EmailSignals,
  type ParsedEmail
} from "../email-extract.js";
import {
  featureGrantsPrefKey,
  isFeatureGranted,
  resolveEffectiveGrants
} from "../feature-grants.js";
import type { SyncLogger } from "../sync-jobs.js";
import {
  classifyLiveReadFailure,
  type DegradedReason,
  type EmailContextItem,
  type EmailContextResult,
  type EmailSuggestedTaskCandidate,
  type ListEmailContextInput,
  type SourceAccountMeta,
  type SourceContextAccountResult,
  type SourceContextGap
} from "./types.js";

/** Newest message keys listed live per account. */
export const LIVE_EMAIL_CAP = 30;
/** Max fresh LLM triages per account per read; beyond this uncached items surface as "unknown". */
export const LIVE_TRIAGE_CAP = 8;

/**
 * Credential access is injected as RESOLVERS (not cipher + secret rows) so the live-read logic
 * stays testable and never handles encrypted material itself. buildSourceContextService composes
 * the real resolvers from the connectors repository + cipher + GoogleConnectionService.
 */
export interface EmailSourceContextDeps {
  readonly connectorsRepository: {
    listAccounts(scopedDb: DataContextDb): Promise<ConnectorAccountSafeRow[]>;
  };
  readonly preferencesRepository: {
    get(scopedDb: DataContextDb, key: string): Promise<unknown>;
  };
  /** Throws when the Google account cannot produce a token (missing/undecryptable/refused). */
  readonly resolveGoogleCredential: (
    scopedDb: DataContextDb,
    opts?: { force?: boolean }
  ) => Promise<string>;
  /** Undefined/throw = auth gap for that account. */
  readonly resolveImapCredential: (
    scopedDb: DataContextDb,
    connectorAccountId: string
  ) => Promise<ImapConnectionSecret | undefined>;
  readonly googleProvider: EmailReadProvider<string>;
  readonly imapProvider: EmailReadProvider<ImapConnectionSecret>;
  readonly emailRepository: {
    listVisibleForBriefing(scopedDb: DataContextDb): Promise<EmailMessage[]>;
    getByConnectorAccountAndExternalId?(
      scopedDb: DataContextDb,
      connectorAccountId: string,
      externalId: string
    ): Promise<EmailMessage | undefined>;
  };
  readonly makeEmailExtractDeps: (scopedDb: DataContextDb) => EmailExtractDeps;
  readonly now?: () => Date;
  readonly logger?: SyncLogger;
}

function accountMeta(row: ConnectorAccountSafeRow): SourceAccountMeta {
  return {
    connectorAccountId: row.id,
    providerId: row.provider_id,
    providerLabel: row.provider_display_name
  };
}

function suggestedTasksFromSignals(signals: EmailSignals): EmailSuggestedTaskCandidate[] {
  return (signals.actionability?.suggestedTasks ?? []).map((task) => ({
    title: task.text,
    dueDate: task.dueDate ?? null
  }));
}

interface TriageFields {
  readonly summary: string | null;
  readonly actionability: EmailContextItem["actionability"];
  readonly importance: EmailContextItem["importance"];
  readonly confidence: number;
  readonly reason: string | null;
  readonly inferredSubject: string | null;
  readonly dueDate: string | null;
  readonly suggestedTasks: readonly EmailSuggestedTaskCandidate[];
}

function triageFromSignals(summary: string | null, signals: EmailSignals): TriageFields {
  return {
    summary,
    actionability: signals.actionability?.category ?? "unknown",
    importance: signals.importance ?? "normal",
    confidence: signals.confidence ?? 0,
    reason: signals.actionability?.reason ?? null,
    inferredSubject: signals.actionability?.inferredSubject ?? null,
    dueDate: signals.actionability?.dueDate ?? null,
    suggestedTasks: suggestedTasksFromSignals(signals)
  };
}

const UNTRIAGED: TriageFields = {
  summary: null,
  actionability: "unknown",
  importance: "normal",
  confidence: 0,
  reason: null,
  inferredSubject: null,
  dueDate: null,
  suggestedTasks: []
};

function cachedSignals(row: EmailMessage): EmailSignals {
  const raw = row.signals;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as EmailSignals) : {};
}

function threadIdFromMetadata(row: EmailMessage | undefined): string | null {
  const metadata = row?.external_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const threadId = (metadata as Record<string, unknown>).threadId;
    if (typeof threadId === "string" && threadId.length > 0) return threadId;
  }
  return null;
}

function receivedAtIso(value: EmailMessage["received_at"]): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cacheKey(connectorAccountId: string, externalId: string): string {
  return JSON.stringify([connectorAccountId, externalId]);
}

/**
 * Honour the sign-in-code decision that was recorded when the message was saved, and never
 * make that decision again here.
 *
 * The decision is taken during sync, where the whole message body is available, and stored on
 * the record as the fixed skip marker. Only a whole body can show that no door, stay, order or
 * voucher wording appears anywhere in the message, and the saved record keeps a short preview
 * at most — so re-running the rule on that preview would hide ordinary mail whose explaining
 * words fall past the preview. A message saved before this filter existed is caught on its
 * next sync, which decides sign-in code messages before anything else and rewrites them.
 */
function otpCheckedTriage(stored: TriageFields, signals: EmailSignals): TriageFields {
  return signals.skipped === "otp" ? UNTRIAGED : stored;
}

export function emailContextItemFromCache(
  row: EmailMessage,
  meta: SourceAccountMeta,
  degradedReason: DegradedReason | null
): EmailContextItem {
  const signals = cachedSignals(row);
  const triage = otpCheckedTriage(triageFromSignals(row.summary, signals), signals);
  return {
    messageKey: row.external_id,
    account: meta,
    sender: row.sender,
    recipients: row.recipients,
    subject: row.subject,
    receivedAt: receivedAtIso(row.received_at),
    threadId: threadIdFromMetadata(row),
    sourceHref: buildEmailActionLink({
      providerId: meta.providerId,
      threadId: threadIdFromMetadata(row)
    }),
    snippet: row.snippet,
    ...triage,
    source: "cache",
    degradedReason,
    cacheMessageId: row.id
  };
}

export async function listSavedEmailContext(
  scopedDb: DataContextDb,
  deps: Pick<
    EmailSourceContextDeps,
    "connectorsRepository" | "preferencesRepository" | "emailRepository"
  >,
  connectorAccountId: string,
  messageKeys?: readonly string[]
): Promise<EmailContextResult> {
  const account = (await deps.connectorsRepository.listAccounts(scopedDb)).find(
    (candidate) => candidate.id === connectorAccountId
  );
  if (!account) return { items: [], accounts: [], gaps: [] };

  const meta = accountMeta(account);
  if (account.status === "revoked") {
    return { items: [], accounts: [], gaps: [{ account: meta, reason: "connector_revoked" }] };
  }
  const stored = await deps.preferencesRepository.get(
    scopedDb,
    featureGrantsPrefKey(connectorAccountId)
  );
  if (!isFeatureGranted(stored, "email")) {
    return { items: [], accounts: [], gaps: [{ account: meta, reason: "feature_grant_disabled" }] };
  }
  if (account.status !== "active") {
    return { items: [], accounts: [], gaps: [{ account: meta, reason: "auth_error" }] };
  }

  const rows =
    messageKeys && deps.emailRepository.getByConnectorAccountAndExternalId
      ? (
          await Promise.all(
            messageKeys.map((key) =>
              deps.emailRepository.getByConnectorAccountAndExternalId!(
                scopedDb,
                connectorAccountId,
                key
              )
            )
          )
        ).filter((row): row is EmailMessage => row !== undefined)
      : await deps.emailRepository.listVisibleForBriefing(scopedDb);
  const items = rows
    .filter((row) => row.connector_account_id === connectorAccountId)
    .map((row) => emailContextItemFromCache(row, meta, null));
  return {
    items,
    accounts: [{ account: meta, source: "cache", degradedReason: null }],
    gaps: []
  };
}

interface LiveReadOutcome {
  readonly items: EmailContextItem[];
}

async function readAccountLive(
  scopedDb: DataContextDb,
  deps: EmailSourceContextDeps,
  account: ConnectorAccountSafeRow,
  meta: SourceAccountMeta,
  cachedByExternalId: ReadonlyMap<string, EmailMessage>,
  credential: { kind: "google"; token: string } | { kind: "imap"; secret: ImapConnectionSecret },
  limit: number
): Promise<LiveReadOutcome> {
  const keys =
    credential.kind === "google"
      ? await deps.googleProvider.listMessageKeys(credential.token, GMAIL_READ_FOLDER)
      : await deps.imapProvider.listMessageKeys(credential.secret, IMAP_DEFAULT_FOLDER);
  const capped = keys.slice(0, Math.min(limit, LIVE_EMAIL_CAP));

  const fetched: ParsedEmail[] = [];
  let failures = 0;
  for (const key of capped) {
    try {
      const message =
        credential.kind === "google"
          ? await deps.googleProvider.getMessage(credential.token, key)
          : await deps.imapProvider.getMessage(credential.secret, key);
      fetched.push(message);
    } catch (error) {
      failures += 1;
      deps.logger?.warn(
        { stage: "source-context-email", accountId: account.id, name: (error as Error)?.name },
        "live email fetch failed for one message"
      );
    }
  }
  if (capped.length > 0 && failures > capped.length / 2) {
    const error = new Error("more than half of live message fetches failed") as Error & {
      statusCode: number;
    };
    error.statusCode = 502;
    throw error;
  }

  const extractDeps = deps.makeEmailExtractDeps(scopedDb);
  let triageBudget = LIVE_TRIAGE_CAP;
  const items: EmailContextItem[] = [];
  for (const message of fetched) {
    const cachedRow = cachedByExternalId.get(cacheKey(account.id, message.externalId));
    const cachedSignalSet = cachedRow ? cachedSignals(cachedRow) : undefined;
    const cachedActionability = cachedSignalSet?.actionability;
    const cachedNeedsActionDetails =
      cachedActionability?.category === "needs_action" ||
      cachedActionability?.category === "needs_reply" ||
      cachedActionability?.category === "time_sensitive_info";
    const cachedActionDetailsComplete =
      Boolean(cachedActionability?.inferredSubject?.trim()) &&
      (cachedActionability?.suggestedTasks?.length ?? 0) > 0;
    let triage: TriageFields;
    if (
      cachedRow &&
      cachedSignalSet &&
      cachedActionability &&
      (!cachedNeedsActionDetails || cachedActionDetailsComplete)
    ) {
      // The live read has the whole message in hand, so the full rule can be applied here as
      // well as the decision stored when it was saved.
      const stored = otpCheckedTriage(
        triageFromSignals(cachedRow.summary, cachedSignalSet),
        cachedSignalSet
      );
      triage = looksLikeOneTimeCodeEmail({
        from: message.from,
        subject: message.subject,
        body: message.body
      })
        ? UNTRIAGED
        : stored;
    } else if (triageBudget > 0) {
      triageBudget -= 1;
      const extracted = await extractEmailSignals(message, extractDeps);
      triage = triageFromSignals(cachedRow?.summary ?? extracted.summary, extracted.signals);
    } else {
      triage = UNTRIAGED;
    }
    items.push({
      messageKey: message.externalId,
      account: meta,
      sender: message.from,
      recipients: message.recipients,
      subject: message.subject,
      receivedAt: message.receivedAt,
      threadId: threadIdFromMetadata(cachedRow),
      sourceHref: buildEmailActionLink({
        providerId: meta.providerId,
        threadId: threadIdFromMetadata(cachedRow)
      }),
      snippet: message.snippet,
      ...triage,
      source: "live",
      degradedReason: null,
      cacheMessageId: cachedRow?.id ?? null
    });
  }
  return { items };
}

export async function listEmailContext(
  scopedDb: DataContextDb,
  deps: EmailSourceContextDeps,
  input: ListEmailContextInput
): Promise<EmailContextResult> {
  const limit = Math.max(1, Math.min(input.limitPerAccount ?? LIVE_EMAIL_CAP, LIVE_EMAIL_CAP));
  const allAccounts = await deps.connectorsRepository.listAccounts(scopedDb);
  const emailCapable = allAccounts.filter(
    (account) => resolveEffectiveGrants(account.scopes, null).email
  );
  if (emailCapable.length === 0) return { items: [], accounts: [], gaps: [] };

  // One cache load serves triage reuse AND transient fallback for every account.
  const cachedRows = await deps.emailRepository.listVisibleForBriefing(scopedDb);
  const cachedByExternalId = new Map(
    cachedRows.map((row) => [cacheKey(row.connector_account_id, row.external_id), row])
  );

  const items: EmailContextItem[] = [];
  const accounts: SourceContextAccountResult[] = [];
  const gaps: SourceContextGap[] = [];

  for (const account of emailCapable) {
    const meta = accountMeta(account);

    if (account.status === "revoked") {
      gaps.push({ account: meta, reason: "connector_revoked" });
      continue;
    }
    const stored = await deps.preferencesRepository.get(scopedDb, featureGrantsPrefKey(account.id));
    if (!isFeatureGranted(stored, "email")) {
      gaps.push({ account: meta, reason: "feature_grant_disabled" });
      continue;
    }
    if (account.status !== "active") {
      gaps.push({ account: meta, reason: "auth_error" });
      continue;
    }
    if (account.provider_type !== "google" && account.provider_type !== "imap") {
      gaps.push({ account: meta, reason: "unsupported_provider" });
      continue;
    }

    // Credential resolution failure = broken auth → gap, never silent cache (spec §4).
    let credential:
      | { kind: "google"; token: string }
      | { kind: "imap"; secret: ImapConnectionSecret };
    try {
      if (account.provider_type === "google") {
        credential = { kind: "google", token: await deps.resolveGoogleCredential(scopedDb) };
      } else {
        const secret = await deps.resolveImapCredential(scopedDb, account.id);
        if (!secret) {
          gaps.push({ account: meta, reason: "auth_error" });
          continue;
        }
        credential = { kind: "imap", secret };
      }
    } catch {
      gaps.push({ account: meta, reason: "auth_error" });
      continue;
    }

    const attempt = () =>
      readAccountLive(scopedDb, deps, account, meta, cachedByExternalId, credential, limit);
    try {
      let outcome: LiveReadOutcome;
      try {
        outcome = await attempt();
      } catch (error) {
        const classified = classifyLiveReadFailure(error);
        if (classified.kind !== "auth" || account.provider_type !== "google") throw error;
        // One forced token refresh, then the auth gap stands (spec §4).
        credential = {
          kind: "google",
          token: await deps.resolveGoogleCredential(scopedDb, { force: true })
        };
        outcome = await attempt();
      }
      items.push(...outcome.items);
      accounts.push({ account: meta, source: "live", degradedReason: null });
    } catch (error) {
      const classified = classifyLiveReadFailure(error);
      if (classified.kind === "auth") {
        gaps.push({ account: meta, reason: "auth_error" });
        continue;
      }
      deps.logger?.warn(
        { stage: "source-context-email", accountId: account.id, name: (error as Error)?.name },
        "live email read failed; serving cache fallback"
      );
      // LIVE_EMAIL_CAP bounds provider fetch cost, not what we already hold: the
      // repository's briefing read is itself bounded AND deliberately rescues older
      // reply-shaped threads that sort last, so a blanket slice here would drop them.
      // Only an explicit caller limit narrows the fallback.
      const fallback = cachedRows
        .filter((row) => row.connector_account_id === account.id)
        .slice(0, input.limitPerAccount !== undefined ? limit : cachedRows.length)
        .map((row) => emailContextItemFromCache(row, meta, classified.degradedReason));
      items.push(...fallback);
      accounts.push({ account: meta, source: "cache", degradedReason: classified.degradedReason });
    }
  }

  items.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
  return { items, accounts, gaps };
}
