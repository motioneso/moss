import { randomUUID } from "node:crypto";

import type { DataContextDb } from "@moss/db";
import { FOCUS_LABELS, FOCUS_REASON_MAX_LENGTH, type FocusLabel } from "@moss/shared";

import {
  FOCUS_JUDGE_MAX_OUTPUT_TOKENS,
  FOCUS_JUDGE_SERVICE_KEY,
  FOCUS_NUDGE_CAP_MINUTES
} from "./constants.js";
import { buildJudgmentPrompt } from "./judgment-prompt.js";
import { decideNudge, type RecentJudgment } from "./nudge-rules.js";
import { FocusJudgmentRepository, type FocusJudgmentStore } from "./repository.js";

/** The calendar block that is on now. Same shape as the calendar's public read, kept local so this
 * library never imports a module. */
export interface FocusCurrentBlock {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface FocusGenerateInput {
  readonly service: typeof FOCUS_JUDGE_SERVICE_KEY;
  readonly schema: Record<string, unknown>;
  readonly prompt: string;
  /** Always true: the judgment model is never defaulted or inherited from another binding. */
  readonly requireExplicitBinding: true;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}

export type FocusGenerateResult =
  | { readonly ok: true; readonly object: unknown }
  | { readonly ok: false; readonly error: string };

export interface FocusLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

/** Everything the service needs from the rest of Moss. Built by the composition root. */
export interface FocusPorts {
  currentBlock(scopedDb: DataContextDb, now: Date): Promise<FocusCurrentBlock | null>;
  /** A plain answer. Never a deferral: a nudge in quiet hours is dropped, not delayed. */
  inQuietHours(scopedDb: DataContextDb, now: Date): Promise<boolean>;
  /** An admin has explicitly bound the judgment model. Never true because of a default. */
  hasJudgeModel(scopedDb: DataContextDb): Promise<boolean>;
  generate(scopedDb: DataContextDb, input: FocusGenerateInput): Promise<FocusGenerateResult>;
  logger: FocusLogger;
}

export interface FocusContext {
  readonly block: FocusCurrentBlock | null;
  readonly judgmentReady: boolean;
}

export interface FocusJudgeInput {
  readonly ownerUserId: string;
  readonly deviceId: string;
  readonly blockId: string;
  readonly appName: string;
  readonly windowTitle: string;
  readonly observedAt: Date;
}

export interface FocusJudgeResult {
  readonly judgmentId: string;
  readonly label: FocusLabel;
  readonly reason: string;
  readonly nudge: boolean;
}

export type FocusErrorCode = "focus_not_ready" | "focus_no_block";

/** A request that stores nothing: the person has no bound model, or the block is not theirs/now. */
export class FocusError extends Error {
  constructor(readonly code: FocusErrorCode) {
    super(code);
    this.name = "FocusError";
  }
}

export interface FocusJudgmentService {
  currentContext(scopedDb: DataContextDb, now: Date): Promise<FocusContext>;
  judge(
    scopedDb: DataContextDb,
    input: FocusJudgeInput,
    now: Date,
    signal: AbortSignal
  ): Promise<FocusJudgeResult>;
  recordCorrection(
    scopedDb: DataContextDb,
    judgmentId: string,
    verdict: "right" | "wrong"
  ): Promise<boolean>;
}

function stripControlCharacters(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

/**
 * Boundary validator for what the model returned. Trusts nothing: exactly the two declared keys,
 * a known label, a reason that is a string, has its control characters removed and fits the cap.
 * Anything else is rejected (the caller stores "insufficient evidence").
 */
export function parseJudgmentAnswer(answer: unknown): { label: FocusLabel; reason: string } | null {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null;
  const record = answer as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("label") || !keys.includes("reason")) return null;

  const label = record.label;
  if (typeof label !== "string" || !(FOCUS_LABELS as readonly string[]).includes(label)) {
    return null;
  }
  if (typeof record.reason !== "string") return null;
  const reason = stripControlCharacters(record.reason).trim();
  if (reason.length > FOCUS_REASON_MAX_LENGTH) return null;
  return { label: label as FocusLabel, reason };
}

export function buildFocusJudgmentService(
  ports: FocusPorts,
  store: FocusJudgmentStore = new FocusJudgmentRepository()
): FocusJudgmentService {
  return {
    async currentContext(scopedDb, now) {
      // No model bound: report "not ready" and read nothing else. A server nobody has configured
      // must answer quietly, never strand a Mac with an error.
      if (!(await ports.hasJudgeModel(scopedDb))) return { block: null, judgmentReady: false };
      return { block: await ports.currentBlock(scopedDb, now), judgmentReady: true };
    },

    async judge(scopedDb, input, now, signal) {
      // Checked first and before any model call: with no explicit binding nothing is processed.
      if (!(await ports.hasJudgeModel(scopedDb))) throw new FocusError("focus_not_ready");

      const block = await ports.currentBlock(scopedDb, now);
      if (!block || block.id !== input.blockId) throw new FocusError("focus_no_block");

      const { prompt, schema } = buildJudgmentPrompt({
        blockTitle: block.title,
        appName: input.appName,
        windowTitle: input.windowTitle
      });

      let answer: { label: FocusLabel; reason: string } | null = null;
      try {
        const generated = await ports.generate(scopedDb, {
          service: FOCUS_JUDGE_SERVICE_KEY,
          schema,
          prompt,
          requireExplicitBinding: true,
          maxOutputTokens: FOCUS_JUDGE_MAX_OUTPUT_TOKENS,
          signal
        });
        if (generated.ok) answer = parseJudgmentAnswer(generated.object);
        else ports.logger.warn({ event: "focus.judge_failed", error: generated.error });
      } catch {
        // Nothing from the error is logged: it can carry the prompt.
        ports.logger.warn({ event: "focus.judge_failed", error: "exception" });
      }

      const label: FocusLabel = answer?.label ?? "insufficient_evidence";
      const reason = answer?.reason ?? "";

      const previous: RecentJudgment[] = await store.listRecentForBlock(scopedDb, block.id, 1);
      const nudge = decideNudge(
        [{ label, at: now }, ...previous],
        await store.lastNudgeAt(scopedDb),
        now,
        {
          capMinutes: FOCUS_NUDGE_CAP_MINUTES,
          inQuietHours: await ports.inQuietHours(scopedDb, now)
        }
      );

      const judgmentId = randomUUID();
      await store.insert(scopedDb, {
        id: judgmentId,
        ownerUserId: input.ownerUserId,
        deviceId: input.deviceId,
        blockRef: block.id,
        label,
        reason,
        nudged: nudge
      });

      // Ids and the label only. Never the app name, the window title or the reason.
      ports.logger.info({ event: "focus.judged", judgmentId, label, nudge });
      return { judgmentId, label, reason, nudge };
    },

    recordCorrection(scopedDb, judgmentId, verdict) {
      return store.setCorrection(scopedDb, judgmentId, verdict);
    }
  };
}
