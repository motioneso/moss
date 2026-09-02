import type { ProviderKind } from "@moss/ai"; // "anthropic" | "openai-compatible" | "google"
import type { ActionRequestPreview } from "@moss/module-sdk";
import type { SourceFreshnessV1 } from "@moss/shared";

export type ChatRecordKind =
  | "user"
  | "thinking"
  | "tool"
  | "status"
  | "reply"
  | "error"
  | "action_request"
  | "action_result";
export interface TranscriptRecord {
  readonly kind: ChatRecordKind;
  readonly text: string;
  readonly messageId?: string;
  readonly actionRequestId?: string;
  readonly toolName?: string;
  /**
   * #2164 r21 correction — the originating `tool_use` block's id (Anthropic transcripts only),
   * carried on both the call's own "tool" record and, keyed the same way, on a distinct
   * rejection signal record (`rejected: true`) when that call was answered with an errored
   * `tool_result`. Lets a caller correlate a call and its rejection even when they arrive on
   * separate `readNew` reads.
   */
  readonly toolCallId?: string;
  /** #2164 r21 correction — true on a rejection signal record for the call named by `toolCallId`. */
  readonly rejected?: boolean;
  readonly summary?: string;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
  /** Live-only structured result for a module-owned inline artifact. */
  readonly result?: Record<string, unknown>;
  /** #1310: dot-path tokens into the frontend `queryKeys` object, for `action_result` records whose tool executed. */
  readonly affectsQueryKeys?: readonly string[];
  readonly sourceFreshness?: SourceFreshnessV1 | null;
  /**
   * Optional rich, server-derived Approve/Deny card preview (email reply recipient/subject/body).
   * Rides the live SSE stream ONLY (whole-record `JSON.stringify` in `/api/chat/stream`); never
   * persisted. Present only on `action_request` records whose tool declared a `preview` hook.
   */
  readonly preview?: ActionRequestPreview;
}

export interface ActionResultMetadata {
  readonly kind: "action_result";
  readonly text: string;
  readonly toolName?: string;
  readonly outcome: "executed" | "denied" | "error" | "allowed";
}

export interface EngineKillOpts {
  /** Terminate the process but retain the exact neutral-dir purge marker for a later boot sweep. */
  readonly preserveNeutralDir?: boolean;
}

export interface EngineLaunchOpts {
  readonly neutralDir: string;
  readonly personaPath: string; // rendered persona context file in neutralDir
  /** Workshop builders may edit only their neutral working directory without a hidden prompt. */
  readonly workspaceWrite?: boolean;
  readonly mcpConfigPath?: string; // Phase 2 (unused in Phase 1)
  /** Opaque per-session MCP bearer token (jst_<uuid>), minted at launch. */
  readonly mcpToken?: string;
  readonly mcpServerUrl?: string; // Phase 2: MCP gateway base URL
  /**
   * NEW (#342 RPC path) — rendered persona CONTENT (not a path). The cli-runner server writes it to
   * the persona file under its server-derived neutralDir. The in-process CliChatEngineImpl IGNORES
   * this and keeps using `personaPath`. Populated by ChatSessionManager.launchSession on every
   * launch (both paths). See rpc-contract.ts RpcLaunchParams.personaText.
   */
  readonly personaText?: string;
  /**
   * NEW (#342 RPC path) — the assembled prior-conversation replay batch as ONE string (memory seed +
   * rolling summary + recent turns), already injection-neutralized by the api. The RPC engine ships
   * it to cli-runner, which submits + drains it server-side; the in-process engine IGNORES it (the
   * manager keeps its own post-launch drain). See rpc-contract.ts RpcLaunchParams.replayBatch.
   */
  readonly replayBatch?: string;
  /** Stable logical attempt ID for a replay submit; wire validation is added with RPC task 5. */
  readonly replayAttemptId?: string;
  /**
   * NEW (#367) — the resolved provider model id from the active chat model row. The auto-registered
   * default is the `"default"` sentinel, for which the launch OMITS `--model` so the CLI rides its
   * own interactive/account model (the PRIMARY path — chat never requires model selection). A
   * CONCRETE id (an explicit settings override) makes the launch pass `--model <id>`; absent ⇒ also
   * omit. See rpc-contract.ts RpcLaunchParams.model.
   */
  readonly model?: string;
}

/** A persistent per-user CLI session. One instance per live session. */
export interface CliChatEngine {
  readonly provider: ProviderKind;
  /**
   * Launch the per-user CLI session and return the post-drain transcript `offset` (§4.0/§4.1.2).
   * CHANGED for #342 from `Promise<void>`: when the engine owns the replay-drain (the cli-runner RPC
   * server), it submits + drains `replayBatch` and returns the transcript length consumed so far
   * (jsonl.length / UTF-16 code units) so the manager can seed `session.transcriptOffset` and the
   * FIRST real `readNew` does not re-read the replay block as the assistant reply.
   *
   * In-process engines that do NOT own the replay-drain (the manager still drains for them) MUST
   * return `{ offset: 0 }`; the manager then keeps overwriting `transcriptOffset` from its own drain.
   */
  launch(opts: EngineLaunchOpts): Promise<{ offset: number }>;
  submit(text: string): Promise<void>; // paste prompt + send
  /** Send a non-destructive Escape/interrupt to the active turn. */
  interrupt(): Promise<void>;
  /** Read transcript records appended since the given byte offset; returns the new offset. */
  readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }>;
  isAlive(): Promise<boolean>;
  kill(opts?: EngineKillOpts): Promise<void>;
  purgeTranscripts?(): Promise<void>;
  /**
   * #456 — re-arm the response deadline for any in-flight turn verb of this engine's session.
   * Called by the manager when it observes new transcript records (activity), so an
   * actively-producing turn never trips the RPC deadline. Optional: the in-process engine (no
   * deadline) does not implement it; the RPC engine forwards to RpcConnection.resetActivityDeadline.
   * The manager guards the call with `?.`.
   */
  resetActivityDeadline?(): void;
}
