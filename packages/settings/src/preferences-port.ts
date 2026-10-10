import type { DataContextDb, PreferencesPort } from "@moss/db";

/** The settings profile uses the shared scoped KV preferences port. */
export type ProfilePreferencesPort = PreferencesPort;

/**
 * ProfilePreferencesPort plus the CAS pair. Scoped to notification-preference writes only (the
 * one key with both a REST writer and an assistant-tool writer sharing setNotificationPreferenceEnabled)
 * — not folded into the shared ProfilePreferencesPort, which every other settings route still uses.
 */
export interface NotificationPreferencesPort extends ProfilePreferencesPort {
  getWithRevision(
    scopedDb: DataContextDb,
    key: string
  ): Promise<{ value: unknown; revision: number } | null>;
  upsertWithRevision(
    scopedDb: DataContextDb,
    key: string,
    value: unknown,
    expectedRevision: number | null
  ): Promise<{ revision: number }>;
}

/** NotificationPreferencesPort plus the versioned read the Profile quiet-hours writer checks. */
export interface QuietHoursPreferencesPort extends NotificationPreferencesPort {
  getVersioned(
    scopedDb: DataContextDb,
    key: string,
    options?: { forUpdate?: boolean }
  ): Promise<{ value: unknown; revision: number; updatedAt: Date } | null>;
}

export interface PersonaPreviewInput {
  readonly actorUserId: string;
  readonly userName: string;
  readonly assistantName: string;
  readonly personaText: string;
}
