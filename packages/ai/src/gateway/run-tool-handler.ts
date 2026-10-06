import { performance } from "node:perf_hooks";
import { types as nodeUtilTypes } from "node:util";

import { HttpError } from "@moss/module-sdk";
import type {
  ModuleAssistantToolManifest,
  ToolContext,
  ToolExecute,
  ToolResult,
  ToolServices
} from "@moss/module-sdk";
import type { AiAssistantToolDto } from "@moss/shared";

import type { InsertAuditLogInput } from "../repository.js";
import {
  classifyToolDependencyFailure,
  describeToolDependencyCause,
  safeErrorName
} from "./dependency-failure.js";
import { renderAndCap, sanitizeAssistantToolResult } from "./output-validation.js";
import { toolHasOutsideContent } from "./content-admission.js";
import type { GatewayToolResponse, PerCallResolution } from "./types.js";

export interface GatewayLogger {
  error(event: string, fields: Record<string, unknown>): void;
}

export interface ExecutableTool {
  readonly tool: ModuleAssistantToolManifest;
  readonly execute: ToolExecute;
  readonly dto: AiAssistantToolDto;
  readonly resolution?: Extract<PerCallResolution, { kind: "proceed" }>;
  readonly services?: ToolServices;
  readonly executePerCall?: () => Promise<ToolResult>;
}

/**
 * Private runHandler return shape: the public envelope plus the audit-log fields, computed once
 * so every call site records them identically. `audit.errorClass` is `null` only for a genuine
 * success (a module self-reporting failure inside an `ok:true` result is not one); the live-stream
 * outcome keys off it too. Never exposed outside this file.
 */
export interface RunHandlerOutcome {
  readonly response: GatewayToolResponse;
  /** Handler-supplied safe error text still needs admission before entering model context. */
  readonly requiresErrorAdmission?: boolean;
  readonly audit: {
    readonly outcome: InsertAuditLogInput["outcome"];
    readonly durationMs: number;
    readonly errorClass: string | null;
  };
}

/**
 * Closed set of conventional error shapes a module handler may return inside an `ok:true`
 * ToolResult. Checked on the raw pre-sanitize payload (#1252) — top-level only, no recursion.
 */
function isModuleReportedError(data: Record<string, unknown>): boolean {
  if (data.status === "error") return true;
  if (data.ok === false) return true;
  if (typeof data.error === "string" && data.error.length > 0) return true;
  return false;
}

export async function runToolHandler(
  found: ExecutableTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  logger: GatewayLogger,
  executeTool: (services: ToolServices) => Promise<ToolResult>,
  services: ToolServices
): Promise<RunHandlerOutcome> {
  const startedAt = performance.now();
  try {
    const result = await executeTool(services);
    const durationMs = Math.round(performance.now() - startedAt);
    const sanitized = sanitizeAssistantToolResult(found.tool.outputSchema, result);
    // Detection must run on the raw pre-sanitize payload: sanitizeAssistantToolResult allow-lists
    // to schema-declared keys, so an undeclared status/ok/error field would already be stripped
    // from structuredData. Applies to every module, built-in or external: isExternal only decides
    // whether a module's INPUT is trusted (validateToolInput above), not whether its output can be
    // taken at face value. Gating on isExternal used to mean a built-in module's self-reported
    // error (e.g. tasks.updateStatus returning {error: "Task not found"} inside an ok:true result)
    // never got flagged and was recorded as a plain "success" (#1252 finding).
    const errorClass = isModuleReportedError(result.data) ? "module_reported" : null;
    return {
      response: {
        ok: true,
        data: renderAndCap(
          found.tool.outputSchema,
          result,
          // Only explicitly trusted user-authored results are exempt. Outside and unmarked
          // results share the same trust-boundary wrapping as their admission policy.
          toolHasOutsideContent(found.tool) ? found.tool.name : undefined
        ),
        structuredData: sanitized.data,
        // #1133 — media (image bytes) bypasses renderAndCap on purpose: sanitize's schema
        // projection would drop the field and the 16k text cap would truncate base64. Size
        // is already bounded at upload (attachment caps), and the payload flows only over
        // the engine's MCP stdio channel — never into logs, DB, or job payloads.
        ...(result.media ? { media: result.media } : {})
      },
      audit: {
        // A tool's execute may request a distinct audit outcome (#2175 Task 7). Only a registry-
        // trusted built-in tool's claim is honoured: an external tool cannot say "suppressed"/
        // "refused" to hide a real failure from audit.
        outcome:
          (found.tool.isExternal === false ? result.auditOutcome : undefined) ??
          (errorClass === null ? "success" : "failed"),
        durationMs,
        errorClass
      }
    };
  } catch (error) {
    // #1251: a tool handler (including third-party module handlers) can throw an arbitrary
    // hostile object. Never touch it — no property access, no instanceof, no prototype walk.
    // isExternal === false trusts the TOOL, not the shape of what it throws — a first-party
    // dependency can still surface a hostile Proxy, so classifyToolDependencyFailure/
    // safeErrorName brand-check with util.types.isNativeError before reading anything, exactly
    // like this branch's untrusted path already refuses to touch `error` at all.
    const isFirstParty = found.tool.isExternal === false;
    const cause = isFirstParty ? classifyToolDependencyFailure(error) : null;
    const errorName = isFirstParty ? safeErrorName(error) : undefined;
    logger.error("tool_handler_threw", {
      toolName: found.dto.name,
      requestId: ctx.requestId,
      errorClass: "handler_error",
      ...(cause ? { cause } : {}),
      ...(errorName ? { errorName } : {})
    });
    const forwardSafeError =
      found.tool.safeErrors === true &&
      nodeUtilTypes.isNativeError(error) &&
      error instanceof HttpError;
    return {
      ...(forwardSafeError ? { requiresErrorAdmission: true } : {}),
      response: {
        ok: false,
        // The cause id goes in the log above; the chat gets ordinary words. The model is free to
        // repeat this text to the user, so it must already read like something a person wrote.
        error: forwardSafeError
          ? error.message
          : cause
            ? `Tool ${found.dto.name} failed: ${describeToolDependencyCause(cause)}.`
            : `Tool ${found.dto.name} failed`
      },
      audit: {
        outcome: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        errorClass: "handler_error"
      }
    };
  }
}
