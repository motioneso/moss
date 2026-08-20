// external-modules/food/src/web/api.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): module-local request helper.
// Vendored from external-modules/finance/src/web/api.ts:33 (ported there from
// job-search) — deliberately NOT @moss/module-web-sdk requestJson, because
// the invoke contract carries its payload
// ({invocation:{blockedReason,...}}) on 403, and requestJson throws away
// non-2xx bodies. Only risk:read tools are ever invoked from this page
// (food.meals.list, food.meals.summarize) — this page
// never calls a write or destructive tool, so there is no manual-run queue
// helper here (contrast finance's runQueue).
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
