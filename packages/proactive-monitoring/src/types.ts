import type { ProactiveMonitoringPreferenceV1, ProactiveSource } from "@moss/shared";

export type { ProactiveSource };

export interface ProactiveMonitorStateRow {
  readonly owner_user_id: string;
  readonly source: string;
  readonly cursor_json: Record<string, unknown>;
  readonly last_checked_at: Date | null;
  readonly failure_count: number;
  readonly last_error_class: string | null;
  readonly updated_at: Date;
}

export interface ProactiveCardRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly source: string;
  readonly stable_key: string;
  readonly source_ref_hash: string;
  readonly title: string;
  readonly summary: string;
  readonly signal_type: string;
  readonly priority_band: "critical" | "high" | "normal" | "low";
  readonly priority_reasons: readonly string[];
  readonly status: "active" | "dismissed" | "expired" | "suppressed";
  readonly occurred_at: Date | null;
  readonly target_at: Date | null;
  readonly first_seen_at: Date;
  readonly last_seen_at: Date;
  readonly deferred_until: Date | null;
  readonly expires_at: Date | null;
  readonly dismissed_at: Date | null;
  readonly metadata_json: Record<string, unknown>;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ResolvedMonitoringConfig {
  readonly preference: ProactiveMonitoringPreferenceV1;
  readonly timeZone: string;
  readonly priorityAnchors: readonly {
    readonly label: string;
    readonly aliases: readonly string[];
  }[];
}

/**
 * Quiet hours from the owner's one saved schedule. When present it replaces the nested alert
 * schedule and is read in its own zone; the cap day keeps the owner locale zone.
 */
export interface ProactiveQuietPolicy {
  readonly enabled: boolean;
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly timeZone: string;
}
