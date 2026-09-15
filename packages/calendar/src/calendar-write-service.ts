import type { ToolContext } from "@moss/module-sdk";
import type { ApplyEventProvenance } from "@moss/shared";

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
  readonly calendarMirror:
    | "written"
    | "skipped-rls"
    | "skipped-error"
    | "not-checked"
    | "not-cached";
  /** Human-facing reason when created=false (e.g. re-consent, no connection). Never a secret. */
  readonly message?: string;
}

export interface CalendarWriteOptions {
  readonly requireCacheMirror?: boolean;
  readonly followThroughTargetRef?: string;
  // Stable apply identity written onto the provider event as private metadata.
  // Present only for reserved apply additions, never for interactive focus blocks.
  readonly provenance?: ApplyEventProvenance;
}

// Provider readback for exactly one event id: found carries the stored summary,
// timing and private provenance metadata the writer recorded at creation.
export type CalendarEventLookup =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly id: string;
      readonly summary: string | null;
      readonly start: string | null;
      readonly end: string | null;
      readonly provenance: Record<string, string>;
      // Provider-side attendee count when the reader saw it. The change path
      // refuses attendee moves and removals regardless of tier or approval.
      readonly attendeeCount?: number | null;
    };

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

export interface RescheduleEventInput {
  readonly eventRef: string; // moss id or external id, resolved via event-resolver
  readonly newStart: Date;
  readonly newEnd: Date;
}

export type RescheduleEventResult =
  | { readonly ok: true; readonly calendarEventId: string }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "has_attendees" | "no_scope" | "provider_error";
      readonly message?: string;
    };

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
  rescheduleEvent(
    scopedDb: unknown,
    ctx: ToolContext,
    input: RescheduleEventInput
  ): Promise<RescheduleEventResult>;
  lookupEvent(
    scopedDb: unknown, // DataContextDb; calendar/impl narrows via assertDataContextDb
    ctx: ToolContext,
    input: { eventId: string }
  ): Promise<CalendarEventLookup>;
}
