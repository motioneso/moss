import type { CredentialPlacement } from "@moss/shared";

import { applyCredential } from "./credentials.js";
import { IntegrationUserError } from "./errors.js";
import {
  DISCOVERY_TIMEOUT_MS,
  RESPONSE_CHAR_CAP,
  retryOnce,
  TOOL_CALL_TIMEOUT_MS
} from "./limits.js";
import type { OpenApiInvocation } from "./openapi-convert.js";

export async function fetchOpenApiSpec(
  specUrl: string,
  secret: string | null,
  placement: CredentialPlacement | null
): Promise<unknown> {
  const url = new URL(specUrl);
  const headers = new Headers({ accept: "application/json" });
  applyCredential(placement, secret, url, headers);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!res.ok) throw new IntegrationUserError(`The spec URL answered with status ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new IntegrationUserError("The spec URL must return JSON.");
  }
}

export async function invokeOpenApiTool(
  baseUrl: string,
  invoke: OpenApiInvocation,
  input: Record<string, unknown>,
  secret: string | null,
  placement: CredentialPlacement | null
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let path = invoke.path;
  const headers = new Headers({ accept: "application/json" });
  const query = new URLSearchParams();
  for (const p of invoke.params) {
    const value = input[p.name];
    if (value === undefined || value === null) continue;
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === "query") query.set(p.name, String(value));
    else headers.set(p.name, String(value));
  }
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [k, v] of query) url.searchParams.set(k, v);
  applyCredential(placement, secret, url, headers);

  let body: string | undefined;
  if (invoke.hasBody && input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  const doFetch = () =>
    fetch(url, {
      method: invoke.method,
      headers,
      body,
      signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS)
    });
  const method = invoke.method.toUpperCase();
  const isSafeToRetry = method === "GET" || method === "HEAD";
  const res = isSafeToRetry ? await retryOnce(doFetch) : await doFetch();
  const text = await res.text();
  const truncated = text.length > RESPONSE_CHAR_CAP;
  const capped = truncated ? text.slice(0, RESPONSE_CHAR_CAP) : text;
  let parsed: unknown = capped;
  if (!truncated) {
    try {
      parsed = JSON.parse(capped);
    } catch {
      /* keep text */
    }
  }
  return {
    ok: res.ok,
    data: { status: res.status, result: parsed, ...(truncated ? { truncated: true } : {}) }
  };
}
