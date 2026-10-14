import { createHash } from "node:crypto";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type {
  ProactiveMonitorInput,
  ProactiveMonitorProvider,
  ProactiveMonitorResult,
  ProactiveMonitorSignal
} from "@moss/module-sdk";

import { EmailRepository } from "./repository.js";

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Messages received within this window are considered recent. */
const RECENT_HOURS = 48;

const REPLY_PATTERN =
  /reply|respond|let me know|can you|please review|follow up|question|action needed/i;

const URGENT_PATTERN = /urgent|asap|time.sensitive|deadline|by [a-z]+ [0-9]/i;

/** URLs with credential-like query params — strip the whole URL to avoid leaking auth state. */
const AUTH_URL_PATTERN =
  /https?:\/\/\S*[?&](token|access_token|session|auth|api_key|apikey|secret|client_secret|code|refresh_token)\S*/gi;

/** Line patterns indicating a secret or credential assignment — redact. */
const CREDENTIAL_LINE_PATTERN =
  /^.*(password|passwd|api[_\s-]?key|secret[_\s-]?key|auth[_\s-]?token|session[_\s-]?token|bearer\s+\S{6,}|private[_\s-]?key|access[_\s-]?token)\s*[:=]\s*\S+.*$/gim;

function sanitizeSnippet(text: string): string {
  return text
    .replace(AUTH_URL_PATTERN, "[link removed]")
    .replace(/\bbearer\s+\S{6,}/gi, "[redacted]")
    .replace(CREDENTIAL_LINE_PATTERN, "[redacted]");
}

export interface EmailMonitorAccess {
  grantedAccountIds(scopedDb: DataContextDb, feature: "email"): Promise<ReadonlySet<string>>;
  isModuleActive(actorUserId: string): Promise<boolean>;
}

export function createEmailMonitorProvider(access: EmailMonitorAccess): ProactiveMonitorProvider {
  return {
    source: "email",
    moduleId: "email",

    async collectSignals(
      scopedDb: unknown,
      input: ProactiveMonitorInput
    ): Promise<ProactiveMonitorResult> {
      assertDataContextDb(scopedDb as DataContextDb);
      const db = scopedDb as DataContextDb;
      if (!(await access.isModuleActive(input.ownerUserId))) {
        return { signals: [], nextCursor: input.sinceCursor };
      }
      const grantedAccountIds = await access.grantedAccountIds(db, "email");
      if (grantedAccountIds.size === 0) {
        return { signals: [], nextCursor: input.sinceCursor };
      }
      const repo = new EmailRepository();
      const now = new Date(input.now);
      const recentCutoff = new Date(now.getTime() - RECENT_HOURS * 60 * 60 * 1000);

      const allMessages = await repo.listVisible(db);
      const recent = allMessages.filter(
        (m) =>
          grantedAccountIds.has(m.connector_account_id) &&
          new Date(m.received_at as unknown as string) >= recentCutoff
      );

      const signals: ProactiveMonitorSignal[] = [];

      for (const msg of recent) {
        if (signals.length >= input.maxSignals) break;

        const text = [msg.subject, msg.snippet ?? "", msg.summary ?? ""].join(" ");
        const needsReply = REPLY_PATTERN.test(text);
        const isUrgent = URGENT_PATTERN.test(text);

        if (!needsReply && !isUrgent) continue;

        const signalType = isUrgent ? "time_sensitive_follow_up" : "needs_reply_soon";
        const stableKey = `email:${stableHash(msg.external_id ?? msg.id)}`;
        const received = new Date(msg.received_at as unknown as string);

        signals.push({
          source: "email",
          stableKey,
          sourceRefHash: stableHash(msg.external_id ?? msg.id),
          signalType,
          title: sanitizeSnippet(msg.subject).slice(0, 200),
          summary: msg.snippet
            ? sanitizeSnippet(msg.snippet).slice(0, 200)
            : isUrgent
              ? "Time-sensitive message needs attention"
              : "Message likely needs a reply",
          occurredAt: received.toISOString(),
          expiresAt: new Date(received.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          priorityCandidate: {}
        });
      }

      return { signals, nextCursor: { checkedAt: input.now } };
    }
  };
}

// The manifest advertises the source; collection needs the composition root's access ports.
export const emailMonitorProvider = createEmailMonitorProvider({
  isModuleActive: async () => false,
  grantedAccountIds: async () => new Set<string>()
});
