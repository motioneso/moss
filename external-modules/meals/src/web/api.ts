// external-modules/meals/src/web/api.ts
//
// Reads only, through the read-tool route. Writes never come through here; they go through the
// host's tools handle in writes.ts.
export type MealsReadToolName =
  | "meals.kitchen.get"
  | "meals.plan.current"
  | "meals.meal.get"
  | "meals.list.get";

export class ReadToolError extends Error {
  constructor(readonly status: number) {
    super(`read failed (${status})`);
  }
}

type InvocationBody = { invocation?: { status?: string; result?: unknown } };

export async function readTool<V>(
  name: MealsReadToolName,
  input: Readonly<Record<string, unknown>>
): Promise<V> {
  const response = await fetch(`/api/ai/assistant-tools/${encodeURIComponent(name)}/invoke`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input })
  });
  const body = (await response.json().catch(() => null)) as InvocationBody | null;
  if (!response.ok || body?.invocation?.status !== "succeeded") {
    throw new ReadToolError(response.status);
  }
  return body.invocation.result as V;
}
