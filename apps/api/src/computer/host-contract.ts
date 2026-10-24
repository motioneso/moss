/** Internal trusted API-to-host protocol; not a browser authentication mechanism. */
export type ComputerHostOperation = "status" | "enable" | "disable" | "recreate";
export interface ComputerHostRequest {
  readonly actorUserId: string;
  readonly operation: ComputerHostOperation;
  readonly expectedGeneration: number;
}
export type ComputerHostReason =
  | "none"
  | "invalid-request"
  | "owner-denied"
  | "stale-generation"
  | "busy"
  | "prerequisite-unavailable"
  | "runtime-unavailable";
export interface ComputerHostResult {
  readonly generation: number;
  readonly enabled: boolean;
  /** Running means Docker processes only, never receiving readiness or usable owner access. */
  readonly state: "disabled" | "unavailable" | "running";
  readonly reason: ComputerHostReason;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Exact own JSON fields shared by the bounded private IPC protocols. */
export function gatewayFields(value: unknown, keys: string): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === keys;
}
export function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}
export function parseHostRequest(value: unknown): ComputerHostRequest {
  const operation = (["status", "enable", "disable", "recreate"] as const).find(
    (candidate) => isRecord(value) && candidate === value.operation
  );
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "actorUserId,expectedGeneration,operation" ||
    !isUuid(value.actorUserId) ||
    !isGeneration(value.expectedGeneration) ||
    !operation
  )
    throw new Error("Invalid host request");
  return {
    actorUserId: value.actorUserId,
    expectedGeneration: value.expectedGeneration,
    operation
  };
}
export function parseHostResult(value: unknown): ComputerHostResult {
  const state = (["disabled", "unavailable", "running"] as const).find(
    (candidate) => isRecord(value) && candidate === value.state
  );
  const reason = (
    [
      "none",
      "invalid-request",
      "owner-denied",
      "stale-generation",
      "busy",
      "prerequisite-unavailable",
      "runtime-unavailable"
    ] as const
  ).find((candidate) => isRecord(value) && candidate === value.reason);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "enabled,generation,reason,state" ||
    !isGeneration(value.generation) ||
    typeof value.enabled !== "boolean" ||
    !state ||
    !reason
  )
    throw new Error("Invalid host response");
  return { generation: value.generation, enabled: value.enabled, state, reason };
}
