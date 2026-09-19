import { actionResultRecord } from "./action-result-record.js";
import type { SessionNotifier } from "./types.js";

export const NATIVE_TOOL_MODULE_ID = "claude-native";
export const NATIVE_TOOL_MODULE_NAME = "Claude Native Tools";
// #1158: read-only native META-tools that must never require a user confirmation.
export const NATIVE_READONLY_AUTO_ALLOW = new Set(["ToolSearch"]);

export interface NativeToolPermissionRequest {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly workingDirectory?: string;
}

export interface NativeToolPermissionResponse {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

/** Maps a native permission outcome to the gateway's provenance-carrying live record. */
export function emitNativePermissionResult(
  notifier: SessionNotifier,
  chatSessionId: string,
  input: {
    readonly actionRequestId: string;
    readonly toolName: string;
    readonly outcome: "allowed" | "denied";
    readonly decidedBy: "person" | "timeout" | "cancelled";
    readonly holdDurationMs: number;
    readonly reason?: string;
  }
): void {
  notifier.emit(
    chatSessionId,
    actionResultRecord({
      ...input,
      ...(input.reason ? { reason: input.reason } : {})
    })
  );
}
