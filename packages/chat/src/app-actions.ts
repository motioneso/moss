import type { FastifyInstance } from "fastify";

import type { RouteCatalog, RouteCatalogHolder, ToolContext } from "@moss/module-sdk";
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

/** The route catalog is filled in `onReady`; a call before then is refused. */
export class AppActionNotReadyError extends Error {
  readonly code = "not_ready";
  constructor() {
    super("App actions are not ready yet");
  }
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
        url: input.path,
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
