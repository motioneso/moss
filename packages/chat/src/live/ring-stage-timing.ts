/**
 * #3842 phase 1: metadata-only stage timing for one voice (ring) turn.
 *
 * The timer records when each stage was first seen, in milliseconds from the
 * turn entering the chat manager. It holds no message text, no transcript, no
 * tool name, no argument and no reply. The emitted line carries only the turn
 * id, stage offsets, a total, whether approval was asked, and a tool count.
 * Earlier stages (button release, upload, transcription) already have durable
 * timestamps on the recording import and voice request rows. This timer covers
 * the stages that only exist inside one live turn.
 */

export const RING_STAGES = [
  "chat_turn_admitted",
  "session_ready",
  "first_model_token",
  "tool_chosen",
  "approval",
  "tool_finished",
  "reply"
] as const;

export type RingStage = (typeof RING_STAGES)[number];
export type RingApproval = "asked" | "skipped" | "none";

export interface RingStageSnapshot {
  readonly turnId: string;
  readonly source: "voice";
  readonly stagesMs: Readonly<Partial<Record<RingStage, number>>>;
  readonly totalMs: number;
  readonly approval: RingApproval;
  readonly toolCount: number;
}

/** Record kinds that are the model's own output. Host status and user echoes are not. */
const MODEL_OUTPUT_KINDS = new Set(["thinking", "thought", "tool", "reply"]);

export class RingStageTimer {
  private readonly startedAt: number;
  private readonly marks = new Map<RingStage, number>();
  private readonly toolCalls = new Set<string>();
  private approvalValue: RingApproval = "none";
  private tools = 0;

  constructor(
    readonly turnId: string,
    private readonly now: () => number
  ) {
    this.startedAt = now();
    this.marks.set("chat_turn_admitted", 0);
  }

  mark(stage: RingStage): void {
    if (!this.marks.has(stage)) this.marks.set(stage, Math.max(0, this.now() - this.startedAt));
  }

  noteModelOutput(kind: string): void {
    if (MODEL_OUTPUT_KINDS.has(kind)) this.mark("first_model_token");
  }

  noteToolChosen(callKey?: string): void {
    if (callKey !== undefined) {
      if (this.toolCalls.has(callKey)) return;
      this.toolCalls.add(callKey);
    }
    this.tools += 1;
    this.mark("tool_chosen");
    if (this.approvalValue === "none") this.approvalValue = "skipped";
  }

  noteApprovalAsked(): void {
    this.approvalValue = "asked";
    this.mark("approval");
  }

  noteToolFinished(): void {
    this.mark("tool_finished");
  }

  snapshot(): RingStageSnapshot {
    const stagesMs: Partial<Record<RingStage, number>> = {};
    for (const stage of RING_STAGES) {
      const value = this.marks.get(stage);
      if (value !== undefined) stagesMs[stage] = Math.round(value);
    }
    if (stagesMs.tool_chosen !== undefined && stagesMs.approval === undefined) {
      stagesMs.approval = stagesMs.tool_chosen;
    }
    return {
      turnId: this.turnId,
      source: "voice",
      stagesMs,
      totalMs: Math.round(Math.max(0, this.now() - this.startedAt)),
      approval: this.approvalValue,
      toolCount: this.tools
    };
  }
}

export function formatRingStageTiming(snapshot: RingStageSnapshot): string {
  return JSON.stringify({ event: "ring_stage_timing", ...snapshot });
}

export function logRingStageTiming(snapshot: RingStageSnapshot): void {
  try {
    console.info(formatRingStageTiming(snapshot));
  } catch {
    // Timing must never break a turn.
  }
}
