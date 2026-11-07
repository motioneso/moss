import type { DataContextDb } from "@moss/db";

/** Time window of one recording, with how far an event may sit outside it. */
export interface ContextWindow {
  readonly start: Date;
  readonly end: Date;
  readonly toleranceMinutes: number;
}

export interface CalendarContextItem {
  readonly eventId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Display names only, never email addresses. */
  readonly attendeeNames: readonly string[];
}

export interface PersonContextItem {
  readonly name: string;
  readonly role: string | null;
  readonly note: string | null;
  readonly matchedName: string;
}

export interface MemoryContextItem {
  readonly query: string;
  readonly text: string;
}

/**
 * Owner context the summary generator may read. Built by the module registry so
 * meetings imports nothing from calendar, people or memory. Every read runs in
 * the owner's data context and carries its own hard cap.
 */
export interface OwnerContextSources {
  ownerProfile(db: DataContextDb): Promise<{ displayName: string; aliases: readonly string[] }>;
  calendar(db: DataContextDb, window: ContextWindow): Promise<readonly CalendarContextItem[]>;
  people(db: DataContextDb, names: readonly string[]): Promise<readonly PersonContextItem[]>;
  memory(db: DataContextDb, queries: readonly string[]): Promise<readonly MemoryContextItem[]>;
}
