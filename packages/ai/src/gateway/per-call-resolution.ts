import type { ToolContext, ToolServices } from "@moss/module-sdk";

import { validateToolInput } from "./input-validation.js";
import type { ExecutableTool } from "./run-tool-handler.js";
import type {
  GatewayDeclineReason,
  GatewayToolResponse,
  PerCallResolver,
  PerCallExecutor,
  PerCallServices
} from "./types.js";

export type PreparedToolCall =
  | { readonly found: ExecutableTool; readonly input: Record<string, unknown> }
  | { readonly failure: GatewayToolResponse; readonly reason: GatewayDeclineReason };

/** Snapshot per-call inputs before resolver lookups, policy planning and approval holds. */
function freezeSnapshot<T>(value: T): T {
  const snapshot: T = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

export async function prepareToolCall(
  found: ExecutableTool,
  rawInput: unknown,
  ctx: ToolContext,
  resolver?: PerCallResolver,
  bindServices?: PerCallServices,
  executePerCall?: PerCallExecutor
): Promise<PreparedToolCall> {
  let input: Record<string, unknown>;
  try {
    input = await validateToolInput(
      found.tool.inputSchema,
      resolver ? freezeSnapshot(rawInput) : rawInput,
      { external: found.tool.isExternal !== false, toolName: found.tool.name }
    );
  } catch (error) {
    return {
      failure: { ok: false, error: error instanceof Error ? error.message : "Invalid input" },
      reason: "invalid_input"
    };
  }
  if (found.tool.requiresPerCallResolution && (!resolver || !bindServices || !executePerCall)) {
    return notReady();
  }
  if (!resolver) return executePerCall ? notReady() : { found, input };

  try {
    Object.freeze(ctx);
    const resolution = freezeSnapshot(await resolver(input, ctx));
    if (resolution.kind === "refuse") {
      return {
        failure: {
          ok: false,
          denied: true,
          reason: [resolution.reason, resolution.category].filter(Boolean).join(": ")
        },
        reason: "refused"
      };
    }
    const required = found.tool.requiresServices ?? [];
    // A resolved read may use only a composition-owned, call-bound capability. The general
    // write-service registry is never a fallback for reads, even when the static tool is write.
    if (resolution.risk === "read" && required.length > 0 && !bindServices) {
      return notReady();
    }
    const services = bindServices?.(input, ctx, resolution);
    if (executePerCall && !services) return notReady();
    if (services && required.some((key) => !(key in services))) return notReady();
    const boundServices = services
      ? Object.freeze(Object.fromEntries(required.map((key) => [key, services[key]])))
      : undefined;
    return {
      found: {
        ...found,
        tool: {
          ...found.tool,
          risk: resolution.risk,
          externalContent: resolution.externalContent,
          content: resolution.externalContent ? "outside" : "user_authored",
          summarize: () => resolution.summary
        },
        dto: { ...found.dto, risk: resolution.risk },
        resolution,
        ...(boundServices ? { services: boundServices } : {}),
        ...(executePerCall && boundServices
          ? { executePerCall: () => executePerCall(input, ctx, resolution, boundServices) }
          : {})
      },
      input
    };
  } catch {
    // Route/consent lookup and capability construction must fail before policy, grants or cards.
    // Exception details can contain row data or credentials, so return only the typed refusal.
    return notReady();
  }
}

function notReady(): PreparedToolCall {
  return { failure: { ok: false, denied: true, reason: "not_ready" }, reason: "refused" };
}

/** Only explicitly declared capabilities reach a write; reads get the read bundle or bound call. */
export function servicesForTool(
  found: ExecutableTool,
  registry: ToolServices = {},
  readServices: ToolServices = {}
): ToolServices {
  if (found.services) return found.services;
  const keys = found.tool.requiresServices ?? [];
  const isRead = found.tool.risk === "read";
  // Existing read tools consume the informational bundle without a declaration. New explicit
  // declarations receive only their keys, always looked up in that same read-only registry.
  if (isRead && keys.length === 0) return readServices;
  const available = isRead ? readServices : registry;
  return Object.fromEntries(
    keys.filter((key) => key in available).map((key) => [key, available[key]])
  );
}
