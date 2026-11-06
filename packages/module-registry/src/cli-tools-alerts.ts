import { randomUUID } from "node:crypto";

import { AiRepository, cliToolReasonText, type ProviderKind } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";
import { NotificationsRepository } from "@moss/notifications";

/**
 * #2689 slice 4: tells instance admins when a tool update is held back, cannot be checked, or a
 * chat was refused for an old tool. Copy is fixed plain words. Raw check output never reaches a
 * notification, the audit log or the health record.
 */

export type CliToolAlertKind =
  | "held_back"
  | "cannot_check"
  | "too_old"
  | "update_check_failed"
  | "summary_stopped";

export interface CliToolAlert {
  readonly kind: CliToolAlertKind;
  readonly provider: ProviderKind;
  /** The candidate version, when there is one. */
  readonly version?: string;
  /** A fixed reason code from the check. */
  readonly reason?: string;
}

const PROVIDER_NAME: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  "openai-compatible": "Codex"
};

const SETTINGS_HREF = "/settings?section=aiproviders";

export function cliToolAlertCopy(alert: CliToolAlert): { title: string; body: string } {
  const name = PROVIDER_NAME[alert.provider] ?? "AI";
  if (alert.kind === "held_back") {
    const version = alert.version ? ` ${alert.version}` : "";
    return {
      title: `${name} update${version} was held back`,
      body:
        `The newer ${name} tools ${cliToolReasonText(alert.reason ?? "")}, so Moss kept the ` +
        `current ones. Open AI providers and press Retry to check again.`
    };
  }
  if (alert.kind === "update_check_failed") {
    const version = alert.version ? ` ${alert.version}` : "";
    return {
      title: `${name} update${version} is installed, but its check failed`,
      body:
        `Moss installed the newer ${name} tools and is using them. The follow-up check ` +
        `${cliToolReasonText(alert.reason ?? "")}. Nothing was rolled back. Open AI providers and press Retry to check again.`
    };
  }
  if (alert.kind === "summary_stopped") {
    return {
      title: `A ${name} summary was stopped`,
      body:
        `Moss stopped a meeting summary before sending the transcript, because the ${name} ` +
        `session ${alert.reason === "unverifiable" ? "could not be verified as locked down" : "reported a protection that was off"}. ` +
        `Only that run stopped. No transcript text is in this alert.`
    };
  }
  if (alert.kind === "cannot_check") {
    return {
      title: "Moss can't check for tool updates",
      body:
        "Moss has not been able to reach the list of tool updates for three days. Your current " +
        "tools keep working. Open AI providers and press Retry once you are back online."
    };
  }
  return {
    title: `${name} chat needs an update`,
    body:
      `The ${name} tools on this server are too old for chat. Moss is looking for a newer ` +
      `version. Open AI providers and press Retry to check now.`
  };
}

/** One alert per toolset, version and kind each day. */
export function cliToolAlertKey(alert: CliToolAlert, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `cli-tools:${alert.kind}:${alert.provider}:${alert.version ?? "-"}:${day}`;
}

export interface CliToolAlertDeps {
  readonly dataContext: DataContextRunner;
  readonly listAdminIds: () => Promise<readonly string[]>;
  readonly now?: () => Date;
  /** The worker role cannot write the action audit log, so it turns this off. */
  readonly writeAuditRow?: boolean;
}

/** Builds the raiser. Each admin gets a notification, an audit row and a health record. */
export function buildCliToolAlertRaiser(
  deps: CliToolAlertDeps
): (alert: CliToolAlert) => Promise<void> {
  const notifications = new NotificationsRepository();
  const ai = new AiRepository();
  const sent = new Set<string>();

  return async (alert) => {
    const now = (deps.now ?? (() => new Date()))();
    const key = cliToolAlertKey(alert, now);
    if (sent.has(key)) return;
    sent.add(key);
    const copy = cliToolAlertCopy(alert);
    for (const actorUserId of await deps.listAdminIds()) {
      const requestId = `cli-tools-alert:${randomUUID()}`;
      await deps.dataContext
        .withDataContext({ actorUserId, requestId }, async (scopedDb) => {
          await notifications.create(scopedDb, {
            moduleId: "ai",
            title: copy.title,
            body: copy.body,
            urgency: "normal",
            eventKey: key,
            href: SETTINGS_HREF,
            metadata: { kind: alert.kind, provider: alert.provider }
          });
          if (deps.writeAuditRow !== false) {
            await ai.insertActionAuditLog(scopedDb, {
              id: randomUUID(),
              ownerUserId: actorUserId,
              toolModuleId: "ai",
              toolName: "cli-tools.update",
              actionFamilyId: null,
              actionKind: "write",
              approvalMode: "auto",
              outcome: alert.kind === "held_back" ? "refused" : "failed",
              errorClass: alert.reason ?? alert.kind,
              requestId,
              chatSessionId: null,
              sourceSurface: "scheduled",
              inputSummary: { inputKeys: ["provider"], inputKeyCount: 1, truncated: false },
              durationMs: null
            });
          }
          await ai.recordError(scopedDb, {
            id: randomUUID(),
            feature: "cli-tools",
            operation: "update",
            errorCategory: alert.kind,
            retryable: true,
            userMessage: copy.title,
            internalSummary:
              `${alert.provider} ${alert.version ?? ""} ${alert.reason ?? ""}`.trim(),
            requestId
          });
        })
        .catch((error: unknown) => {
          console.warn(
            `[cli-tools] alert write failed kind=${alert.kind}: ${error instanceof Error ? error.message : "unknown"}`
          );
        });
    }
  };
}

let summaryStoppedListener:
  | ((info: { readonly cause: "violation" | "unverifiable"; readonly property: string }) => void)
  | undefined;

/** The summary runtime reports a stopped run here. The alert raiser is attached at startup. */
export function setSummaryStoppedListener(listener: typeof summaryStoppedListener): void {
  summaryStoppedListener = listener;
}

export function notifySummaryStopped(info: {
  readonly cause: "violation" | "unverifiable";
  readonly property: string;
}): void {
  summaryStoppedListener?.(info);
}

/** Turns a stopped-summary report into an admin alert. Used by the API and the worker process. */
export function buildSummaryStoppedListener(
  raiseAlert: (alert: CliToolAlert) => Promise<void>
): (info: { readonly cause: "violation" | "unverifiable"; readonly property: string }) => void {
  return (info) => {
    void raiseAlert({ kind: "summary_stopped", provider: "anthropic", reason: info.cause }).catch(
      (error: unknown) => {
        console.warn(
          `[cli-tools] summary-stopped alert failed: ${error instanceof Error ? error.message : "unknown"}`
        );
      }
    );
  };
}

/** What a chat turn refused for an old tool triggers: an alert, then an update pass right away. */
export function buildCliVersionTooOldHandler(deps: {
  readonly raiseAlert: (alert: CliToolAlert) => Promise<void>;
  readonly pass: () => Promise<void>;
}): () => void {
  return () => {
    void deps.raiseAlert({ kind: "too_old", provider: "anthropic" }).catch(() => undefined);
    void deps.pass().catch(() => undefined);
  };
}
