import type { ProviderKind } from "@moss/ai";

import type { RpcErrorCode } from "./rpc-contract.js";

export type ChatEngineReadFailureClass =
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "unknown";

export type ChatEngineReadFailureStage =
  | "acp_prompt_rejected"
  | "acp_prompt_timeout"
  | "acp_transport_error"
  | "rpc_error"
  | "provider_response"
  | "unknown";

export interface ChatEngineReadFailureDiagnostic {
  readonly source: "engine.readNew";
  readonly provider: ProviderKind;
  readonly classification: ChatEngineReadFailureClass;
  readonly failureStage: ChatEngineReadFailureStage;
  readonly rpcCode?: RpcErrorCode;
  readonly statusCode?: number;
  readonly acpCode?: number;
}

const RPC_ERROR_CODES = new Set<RpcErrorCode>([
  "unavailable",
  "delivery_unknown",
  "not_launched",
  "bad_request",
  "internal"
]);

export function chatEngineReadFailureDiagnostic(
  provider: ProviderKind,
  error: unknown
): ChatEngineReadFailureDiagnostic {
  const rpcCodeValue = readOwnDataProperty(error, "rpcCode") ?? readOwnDataProperty(error, "code");
  const rpcCode =
    typeof rpcCodeValue === "string" && RPC_ERROR_CODES.has(rpcCodeValue as RpcErrorCode)
      ? (rpcCodeValue as RpcErrorCode)
      : undefined;
  const statusValue = readOwnDataProperty(error, "statusCode");
  const statusCode =
    typeof statusValue === "number" &&
    Number.isInteger(statusValue) &&
    statusValue >= 400 &&
    statusValue <= 599
      ? statusValue
      : undefined;
  const acpCodeValue = readOwnDataProperty(error, "acpCode");
  const acpCode =
    typeof acpCodeValue === "number" &&
    Number.isInteger(acpCodeValue) &&
    acpCodeValue >= -32_768 &&
    acpCodeValue <= -32_000
      ? acpCodeValue
      : undefined;
  const stageValue = readOwnDataProperty(error, "failureStage");
  const allowedStages = new Set<ChatEngineReadFailureStage>([
    "acp_prompt_rejected",
    "acp_prompt_timeout",
    "acp_transport_error",
    "rpc_error",
    "provider_response",
    "unknown"
  ]);
  const failureStage =
    typeof stageValue === "string" && allowedStages.has(stageValue as ChatEngineReadFailureStage)
      ? (stageValue as ChatEngineReadFailureStage)
      : rpcCode
        ? "rpc_error"
        : statusCode !== undefined
          ? "provider_response"
          : "unknown";
  const classification: ChatEngineReadFailureClass =
    statusCode === 401 || statusCode === 403
      ? "authentication"
      : statusCode === 429
        ? "rate_limited"
        : statusCode === 408 || statusCode === 504
          ? "timeout"
          : statusCode !== undefined
            ? "upstream_error"
            : failureStage === "acp_prompt_timeout"
              ? "timeout"
              : failureStage === "acp_prompt_rejected"
                ? "upstream_error"
                : "unknown";

  return {
    source: "engine.readNew",
    provider,
    classification,
    failureStage,
    ...(rpcCode ? { rpcCode } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(acpCode !== undefined ? { acpCode } : {})
  };
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export class ChatEngineReadError extends Error {
  constructor(readonly diagnostic: ChatEngineReadFailureDiagnostic) {
    super("readNew failed");
    this.name = "ChatEngineReadError";
  }
}

export function mapChatEngineReadError(provider: ProviderKind, error: unknown): Error {
  if (error instanceof CliChatUnavailableError) return error;
  return new ChatEngineReadError(chatEngineReadFailureDiagnostic(provider, error));
}

/**
 * Thrown when a live CLI session cannot be hosted: no terminal multiplexer
 * (tmux/herdr) is available/configured, OR the chosen multiplexer failed to launch
 * the session. Both map to HTTP 503. `cause` carries the underlying error for
 * server-side logging; the message is operator-safe (no secrets/stderr leakage).
 */
export class CliChatUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliChatUnavailableError";
  }
}

/**
 * #2348 — thrown when the app and the model program genuinely disagree about where the
 * answer file lives: the program has had a fair chance to create its project folder and
 * never did. Distinct from an ordinary "still writing" miss, which never throws. The
 * message names only the expected folder path — no prompt or reply content.
 */
export class CliTranscriptLocationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliTranscriptLocationMismatchError";
  }
}

/** Enter may have reached provider, but exact transcript ACK was not observed. Never auto-retry. */
export class CliChatDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliChatDeliveryUnknownError";
  }
}

export class ChatTurnInFlightError extends Error {
  constructor() {
    super("A chat turn is already in progress. Wait for it to finish before sending another.");
    this.name = "ChatTurnInFlightError";
  }
}

export class ChatStreamLimitError extends Error {
  constructor() {
    super("Too many open chat streams for this user.");
    this.name = "ChatStreamLimitError";
  }
}

export class ChatThreadNotFoundError extends Error {
  constructor() {
    super("Chat thread not found or does not belong to this user.");
    this.name = "ChatThreadNotFoundError";
  }
}

export function mapRpcError(code: RpcErrorCode, message: string, statusCode?: number): Error {
  if (code === "delivery_unknown") return new CliChatDeliveryUnknownError(message);
  if (code === "unavailable" || code === "not_launched") {
    return new CliChatUnavailableError(message);
  }
  const error = new Error(message) as Error & {
    readonly rpcCode: RpcErrorCode;
    readonly statusCode?: number;
  };
  Object.defineProperty(error, "rpcCode", { value: code, enumerable: true });
  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
  ) {
    Object.defineProperty(error, "statusCode", { value: statusCode, enumerable: true });
  }
  return error;
}
