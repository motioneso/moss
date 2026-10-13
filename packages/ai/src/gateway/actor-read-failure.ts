import { classifyToolDependencyFailure } from "./dependency-failure.js";
import type { ExecutableTool, GatewayLogger } from "./run-tool-handler.js";
import type { GatewayToolResponse } from "./types.js";

export function actorReadFailure(
  found: ExecutableTool,
  requestId: string,
  error: unknown,
  logger: GatewayLogger
): GatewayToolResponse {
  const cause = found.tool.isExternal === false ? classifyToolDependencyFailure(error) : null;
  logger.error("read_tool_handler_threw", {
    toolName: found.tool.name,
    requestId,
    errorClass: "handler_error"
  });
  return {
    ok: false,
    error: `Tool ${found.tool.name} failed`,
    failureKind: "read",
    ...(cause && cause !== "upstream_http_error" ? { retryable: true as const } : {})
  };
}
