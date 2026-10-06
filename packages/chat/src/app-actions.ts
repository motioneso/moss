import type { FastifyInstance } from "fastify";
import { isDeepStrictEqual } from "node:util";
import type { DataContextRunner } from "@moss/db";
import type { ActiveModulesResolver, PerCallResolution, PerCallResolver } from "@moss/ai";

import {
  canonicalAppPath,
  type RouteCatalog,
  type RouteCatalogHolder,
  type ToolContext
} from "@moss/module-sdk";
import { ACT_AS_GRANT_HEADER, type ActAsGrantRegistry } from "@moss/module-sdk/server";

/**
 * #3065: Moss calls the app's own HTTP routes in process as the chat user. Each call carries a
 * fresh single-use act-as grant and no cookie or bearer token, so it passes the same route
 * guard, module-enablement check, row-level security and validation as a browser request.
 */

export interface AppActionCallInput {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

export interface AppActionsService {
  catalog(): RouteCatalog | null;
  call(input: AppActionCallInput, ctx: ToolContext): Promise<{ status: number; body: unknown }>;
}

/** The router could read the path differently from the catalog, so the call is refused. */
export class AppActionPathError extends Error {
  readonly code = "non_canonical_path";
  constructor() {
    super("App action path is not canonical");
  }
}

/** The route catalog is filled in `onReady`; a call before then is refused. */
export class AppActionNotReadyError extends Error {
  readonly code = "not_ready";
  constructor() {
    super("App actions are not ready yet");
  }
}

/** Safe, fixed reasons only: never include a rejected request or response in the error. */
export class AppActionRefusedError extends Error {
  constructor(readonly code: string) {
    super(`App action refused: ${code}`);
  }
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function actionInput(input: Record<string, unknown>): AppActionCallInput | null {
  if (typeof input.method !== "string" || !METHODS.has(input.method)) return null;
  if (typeof input.path !== "string" || canonicalAppPath(input.path) === null) return null;
  if (
    input.query !== undefined &&
    (input.query === null ||
      typeof input.query !== "object" ||
      Array.isArray(input.query) ||
      Object.values(input.query).some((value) => typeof value !== "string"))
  )
    return null;
  return input as unknown as AppActionCallInput;
}

/** Exact JSON values are shown as text; never truncate a value the person is approving. */
function callFields(input: AppActionCallInput) {
  const fields = [
    { label: "Method", value: input.method },
    { label: "Path", value: input.path }
  ];
  for (const [key, value] of Object.entries(input.query ?? {})) {
    fields.push({ label: `Query: ${key}`, value: JSON.stringify(value) });
  }
  if (input.body !== undefined) {
    if (input.body !== null && typeof input.body === "object" && !Array.isArray(input.body)) {
      for (const [key, value] of Object.entries(input.body)) {
        fields.push({ label: `Body: ${key}`, value: JSON.stringify(value) });
      }
    } else {
      fields.push({ label: "Body", value: JSON.stringify(input.body) });
    }
  }
  return fields;
}

/** Resolve before policy planning, target disclosure, capability binding or grant minting. */
export function createAppActionResolver(deps: {
  readonly appActions: AppActionsService;
  readonly runner: Pick<DataContextRunner, "withDataContext">;
  readonly resolveActiveModules: ActiveModulesResolver;
}): PerCallResolver {
  return async (rawInput, ctx) => {
    const catalog = deps.appActions.catalog();
    if (!catalog) return { kind: "refuse", reason: "not_ready" };
    const input = actionInput(rawInput);
    const match = input ? catalog.resolve(input.method, input.path) : null;
    if (!input || !match) return { kind: "refuse", reason: "unknown_route" };
    const { route, params } = match;
    const policy = route.policy;
    if (policy.access === "blocked") {
      return { kind: "refuse", reason: "blocked", category: policy.blockedBecause };
    }
    const risk = policy.access;
    const module = (await deps.resolveActiveModules(ctx.actorUserId)).find(
      (manifest) => manifest.id === route.moduleId
    );
    if (!module) return { kind: "refuse", reason: "unknown_route" };
    const access = { actorUserId: ctx.actorUserId, requestId: ctx.requestId };
    return deps.runner.withDataContext(access, async (scopedDb): Promise<PerCallResolution> => {
      // A malformed consent declaration also refuses. No target lookup or response can leak
      // before this check, and approving a call never changes the preference.
      if (module.aiConsent || policy.consent) {
        if (
          !module.aiConsent ||
          policy.consent !== module.aiConsent.key ||
          !(await module.aiConsent.isGranted(scopedDb, ctx.actorUserId))
        )
          return { kind: "refuse", reason: "consent_off" };
      }
      const target = policy.target ? await policy.target(scopedDb, params) : null;
      if (policy.target && target === null) return { kind: "refuse", reason: "unknown_route" };
      return {
        kind: "proceed",
        risk,
        externalContent: policy.content === "outside",
        forceConfirm: risk === "destructive",
        confirmWhenTainted: policy.outbound === true,
        summary: policy.title ?? `Read ${route.moduleId}`,
        details: { target, fields: callFields(input) },
        affectsModules: risk === "read" ? [] : [route.moduleId]
      };
    });
  };
}

/**
 * A server-resolved read may execute through inject, but receives no general write registry.
 * This one-shot capability can call only the frozen request whose effective policy was planned.
 */
export function createAppActionCallServices(deps: {
  readonly appActions: AppActionsService;
  readonly resolver: PerCallResolver;
}) {
  return (
    input: Record<string, unknown>,
    ctx: ToolContext,
    resolution: Extract<PerCallResolution, { kind: "proceed" }>
  ) => {
    let consumed = false;
    return {
      appActions: {
        async call(request: AppActionCallInput, caller: ToolContext) {
          if (consumed || !isDeepStrictEqual(input, request) || !isDeepStrictEqual(ctx, caller)) {
            throw new AppActionRefusedError("invalid_call_binding");
          }
          consumed = true;
          // Consent, module availability and destructive labels may change while a card waits.
          // Any difference needs a fresh call/card, never silent retargeting under old approval.
          const current = await deps.resolver(input, ctx);
          if (current.kind === "refuse") throw new AppActionRefusedError(current.reason);
          if (!isDeepStrictEqual(current, resolution)) {
            throw new AppActionRefusedError("approval_changed");
          }
          const bound = actionInput(input);
          if (!bound) throw new AppActionRefusedError("invalid_call_binding");
          return deps.appActions.call(bound, ctx);
        }
      }
    };
  };
}

export function createAppActionsService(deps: {
  readonly server: FastifyInstance;
  readonly catalog: RouteCatalogHolder;
  readonly grants: ActAsGrantRegistry;
  readTurnId(chatSessionId: string): string | null;
}): AppActionsService {
  return {
    catalog: () => deps.catalog.get(),
    async call(input, ctx) {
      if (!deps.catalog.get()) throw new AppActionNotReadyError();
      const path = canonicalAppPath(input.path);
      if (path === null) throw new AppActionPathError();

      const grant = deps.grants.mint({
        actorUserId: ctx.actorUserId,
        chatSessionId: ctx.chatSessionId,
        turnId: deps.readTurnId(ctx.chatSessionId)
      });
      const hasBody = input.body !== undefined;
      const headers: Record<string, string> = { [ACT_AS_GRANT_HEADER]: grant };

      // Fastify rejects a JSON content type with an empty body, so a bodyless call omits it.
      if (hasBody) headers["content-type"] = "application/json";
      if (ctx.localTimezone) headers["x-timezone"] = ctx.localTimezone;

      const response = await deps.server.inject({
        method: input.method,
        url: path,
        ...(input.query ? { query: input.query } : {}),
        headers,
        ...(hasBody ? { payload: JSON.stringify(input.body) } : {})
      });
      return { status: response.statusCode, body: parseBody(response) };
    }
  };
}

function parseBody(response: { headers: Record<string, unknown>; body: string }): unknown {
  if (response.body.length === 0) return null;
  const contentType = String(response.headers["content-type"] ?? "");
  if (!contentType.includes("json")) return response.body;
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return response.body;
  }
}
