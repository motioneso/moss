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

/**
 * The host drops a manual run that starts within five seconds of the last one on the
 * same queue, whatever its parameters, and still answers 202. Writes therefore go
 * through one sender per queue that spaces runs apart, merges waiting commands when the
 * caller allows it, and treats a dropped run as a failure rather than a success.
 */
export const WRITE_SPACING_MS = 5200;
const DROPPED_RETRIES = 2;

interface WriteEntry {
  jobKind: string;
  params: Record<string, unknown> | undefined;
  waiting: Array<(outcome: RunOutcome) => void>;
}

interface WriteQueue {
  entries: WriteEntry[];
  lastSentAt: number;
  running: boolean;
}

const writeQueues = new Map<string, WriteQueue>();

export type MergeParams = (
  waiting: Record<string, unknown>,
  incoming: Record<string, unknown>
) => Record<string, unknown> | null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function drainWrites(queueName: string, queue: WriteQueue): Promise<void> {
  queue.running = true;
  while (queue.entries.length > 0) {
    const wait = queue.lastSentAt + WRITE_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const entry = queue.entries.shift() as WriteEntry;
    let outcome: RunOutcome = { kind: "already-queued" };
    for (let attempt = 0; attempt <= DROPPED_RETRIES; attempt += 1) {
      queue.lastSentAt = Date.now();
      outcome = await runQueue(queueName, entry.jobKind, entry.params);
      if (outcome.kind !== "already-queued") break;
      await sleep(WRITE_SPACING_MS);
    }
    if (outcome.kind === "already-queued") {
      outcome = { kind: "error", message: "The request was dropped" };
    }
    for (const done of entry.waiting) done(outcome);
  }
  queue.running = false;
}

/**
 * Sends a write command. Resolves "queued" only when the host really started a run.
 * `merge` lets a command join one that is still waiting its turn; return null to keep
 * them separate.
 */
export function runWrite(
  queueName: string,
  jobKind: string,
  params?: Record<string, unknown>,
  merge?: MergeParams
): Promise<RunOutcome> {
  let queue = writeQueues.get(queueName);
  if (!queue) {
    queue = { entries: [], lastSentAt: 0, running: false };
    writeQueues.set(queueName, queue);
  }
  const target = queue;
  return new Promise((resolve) => {
    const last = target.entries[target.entries.length - 1];
    if (merge && last && last.jobKind === jobKind && last.params && params) {
      const merged = merge(last.params, params);
      if (merged) {
        last.params = merged;
        last.waiting.push(resolve);
        return;
      }
    }
    target.entries.push({ jobKind, params, waiting: [resolve] });
    if (!target.running) void drainWrites(queueName, target);
  });
}

/** Test hook: forget spacing and waiting commands. */
export function resetWriteQueues(): void {
  writeQueues.clear();
}
