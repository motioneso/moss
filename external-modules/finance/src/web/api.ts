// external-modules/finance/src/web/api.ts
// FIN-02 (#1147) Task 11: module-local request helpers, ported from
// job-search's web contract. Deliberately NOT @moss/module-web-sdk
// requestJson — the invoke contract carries its payload
// ({invocation:{blockedReason,...}}) on 403, and requestJson throws away
// non-2xx bodies. Only risk:read tools are ever invoked here (D4: the REST
// invoke route 403s non-read tools); every write goes through the module's
// manual-run queue endpoint via runQueue below.
import type { DirectoryUser } from "./household";

export type ToolOutcome<T> =
  | { kind: "ok"; result: T }
  | { kind: "blocked"; reason: string }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

type InvocationBody = {
  invocation?: {
    status?: string;
    blockedReason?: string | null;
    result?: Record<string, unknown> | null;
  };
};

async function parseJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function invokeTool<T extends Record<string, unknown>>(
  name: string,
  input?: Record<string, unknown>
): Promise<ToolOutcome<T>> {
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetch(`/api/ai/assistant-tools/${encodeURIComponent(name)}/invoke`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: input ?? {} })
    });
  } catch {
    return { kind: "error", message: "Network error" };
  }
  // 404 = tool not declared = module disabled/uninstalled server-side. A stale
  // browser session must fail closed to the disabled state (job-search spec).
  if (response.status === 404) return { kind: "disabled" };
  const body = (await parseJson(response)) as InvocationBody | null;
  const invocation = body?.invocation;
  if (response.ok && invocation?.status === "succeeded") {
    return { kind: "ok", result: (invocation.result ?? {}) as T };
  }
  if (invocation?.status === "blocked") {
    return { kind: "blocked", reason: invocation.blockedReason ?? "blocked" };
  }
  return { kind: "error", message: `Request failed (${response.status})` };
}

/**
 * FIN-04 (#1149): resolve household owner ids to display names via the host's
 * authenticated directory (GET /api/users/directory — id + name of ACTIVE
 * users only; the route schema is the redaction enforcement, no emails).
 * Returns null on ANY failure so callers fail closed: resolveSharedOwners
 * drops every shared entry rather than render unattributed household data.
 */
export async function fetchUserDirectory(): Promise<DirectoryUser[] | null> {
  let response: { ok: boolean; json: () => Promise<unknown> };
  try {
    response = await fetch("/api/users/directory", { credentials: "include" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await parseJson(response)) as { users?: DirectoryUser[] } | null;
  return Array.isArray(body?.users) ? body.users : null;
}

export type RunOutcome =
  | { kind: "queued" }
  | { kind: "already-queued" }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

/**
 * Enqueue a manual run on one of the module's declared queues
 * (POST /api/modules/finance/queues/:queueName/run — the host route accepts
 * exactly {jobKind, params?}). Params are only legal when the queue declares
 * a paramsSchema (sendModuleJob rejects them otherwise), so callers omit the
 * argument for finance.sync-run / finance.connect-poll and pass the four
 * identifier ids for finance.categorize-apply — metadata-only payloads, per
 * the repo-wide hard invariant (D6: never notes, never content).
 */
export async function runQueue(
  queueName: string,
  jobKind: string,
  params?: Record<string, unknown>
): Promise<RunOutcome> {
  let response: { status: number; json: () => Promise<unknown> };
  try {
    response = await fetch(`/api/modules/finance/queues/${encodeURIComponent(queueName)}/run`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobKind, ...(params ? { params } : {}) })
    });
  } catch {
    return { kind: "error", message: "Network error" };
  }
  if (response.status === 202) {
    const body = (await parseJson(response)) as { jobId?: string | null } | null;
    // jobId:null = the manual singleton for this actor is already queued —
    // report queued state without duplicating (defensive branch carried from
    // job-search; starts firing once #965 adds dedupe on the route).
    return body && body.jobId ? { kind: "queued" } : { kind: "already-queued" };
  }
  if (response.status === 404) return { kind: "disabled" };
  return { kind: "error", message: `Request failed (${response.status})` };
}

/**
 * True when the signed-in user is an admin. The admin-only credential list
 * answers 200 for admins and 403 for everyone else, so the host's own
 * authorization decides; any failure reads as "not an admin" (fail closed).
 */
export async function fetchIsAdmin(): Promise<boolean> {
  try {
    const response = await fetch("/api/admin/modules/finance/credentials", {
      credentials: "include"
    });
    return response.ok;
  } catch {
    return false;
  }
}
