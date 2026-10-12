import type { QuietHoursCommand } from "../quiet-hours-recognizer.js";
import type { PgBoss } from "pg-boss";
import type { DataContextDb } from "@moss/db";
import type { ChatReminderOriginV1 } from "@moss/shared";
import type { LocalClockSpec } from "../clock-recognizer.js";
import type { ReminderLocale } from "../clock-wording.js";
import type { ReminderUnsupportedReason } from "../recognizer.js";
import type { ReminderRepository } from "../repository.js";

/** What the raw request asked for, before anything is checked against storage. */
export type ReminderTurnPlan =
  | QuietHoursCommand
  | { readonly kind: "request"; readonly delaySeconds: number; readonly text: string }
  | { readonly kind: "clock_request"; readonly clock: LocalClockSpec; readonly text: string }
  | { readonly kind: "unsupported"; readonly reason: ReminderUnsupportedReason }
  | { readonly kind: "list" }
  | { readonly kind: "cancel"; readonly target: string | null }
  | { readonly kind: "pause" | "resume" | "delete"; readonly target: string | null }
  | { readonly kind: "confirm_delete"; readonly agree: boolean }

  /** A save, list or cancel refused before it reaches storage. `manage` marks list or cancel. */
  | { readonly kind: "main_only"; readonly manage?: boolean };

export interface ReminderTurnDecision {
  readonly reply: string;
  readonly origin: ChatReminderOriginV1;

  /** Saves the reminder once the user message exists. Absent when nothing is saved. */
  readonly save?: (userMessageId: string) => Promise<void>;
}

export interface ReminderCommandContext {
  readonly scopedDb: DataContextDb;
  readonly deps: {
    readonly reminders: ReminderRepository;
    readonly boss: Pick<PgBoss, "send"> | undefined;
    readonly locale: () => Promise<ReminderLocale>;
  };
  readonly actorUserId: string;
  readonly userText?: string;
  readonly thread: { readonly id: string; readonly is_main: boolean; readonly incognito: boolean };
}

export type ReminderCommandHandler = (
  context: ReminderCommandContext,
  plan: ReminderTurnPlan
) => Promise<ReminderTurnDecision>;
