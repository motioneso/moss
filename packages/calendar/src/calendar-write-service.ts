import type { ToolContext } from "@moss/module-sdk";

export interface FocusBlockWindow {
  readonly start: Date;
  readonly end: Date;
  /**
   * The REQUESTED block length in minutes (already clamped to 15..480 by resolveWindow).
   * Load-bearing: `start`..`end` is the SEARCH WINDOW (e.g. the whole morning band), not
   * the block length. The impl must insert a block of `durationMinutes`, NOT (end - start).
   * Dropping this field silently turns "2 hours tomorrow morning" into a 3-hour band block.
   */
  readonly durationMinutes: number;
  readonly title: string;
}

export interface ProposeFocusResult {
  readonly created: boolean;
  readonly resolvedStart: string; // ISO
  readonly resolvedEnd: string; // ISO
  readonly shifted: boolean;
  readonly conflict: "none" | "shifted" | "no-clear-slot";
  readonly googleEventId?: string;
  readonly calendarEventId?: string;
  readonly calendarMirror: "written" | "skipped-rls" | "skipped-error";
  /** Human-facing reason when created=false (e.g. re-consent, no connection). Never a secret. */
  readonly message?: string;
}

export interface CalendarWriteOptions {
  readonly requireCacheMirror?: boolean;
  readonly followThroughTargetRef?: string;
}

export interface DeleteEventInput {
  readonly eventId: string; // Jarvis cached event uuid (authoritative)
}

export interface DeleteEventResult {
  readonly deleted: boolean;
  readonly googleDeleted: "deleted" | "already-gone" | "skipped-no-scope" | "skipped-error";
  readonly cacheMirror: "queued" | "deleted" | "skipped-rls" | "skipped-error" | "not-cached";
  readonly deletedTitle?: string;
  readonly message?: string;
}

/**
 * The contract the calendar focus-time tool depends on. OWNED BY packages/calendar so no
 * connectors import leaks into the calendar module. The concrete implementation is built
 * in the composition host (packages/chat), which is allowed to import connectors. The tool
 * narrows the injected `services.calendarWrite` to this interface.
 */
export interface CalendarWriteService {
  createEvent(
    scopedDb: unknown, // DataContextDb; calendar/impl narrows via assertDataContextDb
    ctx: ToolContext,
    window: FocusBlockWindow,
    options?: CalendarWriteOptions
  ): Promise<ProposeFocusResult>;
  deleteEvent(
    scopedDb: unknown,
    ctx: ToolContext,
    input: DeleteEventInput
  ): Promise<DeleteEventResult>;
}
