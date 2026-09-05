import type { ColumnType, Selectable } from "kysely";

type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestampColumn = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type JsonColumn = ColumnType<
  Record<string, unknown>,
  Record<string, unknown> | undefined,
  Record<string, unknown>
>;
type TextArrayColumn = ColumnType<
  string[],
  readonly string[] | string[] | undefined,
  readonly string[] | string[]
>;
type NullableTextArrayColumn = ColumnType<
  string[] | null,
  readonly string[] | string[] | null | undefined,
  readonly string[] | string[] | null
>;
type NullableNumberArrayColumn = ColumnType<
  number[] | null,
  readonly number[] | number[] | null | undefined,
  readonly number[] | number[] | null
>;

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: TimestampColumn;
}

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
  image: string | null;
  is_instance_admin: boolean;
  status: "pending" | "active" | "deactivated";
  is_bootstrap_owner: boolean;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface MemberOnboardingTable {
  user_id: string;
  completed_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

/**
 * Provider install/login lifecycle state (#342 Phase 2, install-contract §A.4 / §9.2).
 * One row per provider (instance-global, ADR 0007). `state` mirrors the frozen
 * `ProviderInstallState` enum (packages/shared/src/onboarding-api.ts). Writes are
 * admin-only (0103 RLS); reads are allowed to all authed actors.
 */
export interface ProviderInstallStateTable {
  provider: string;
  state: string;
  version: string | null;
  message: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AuthSessionsTable {
  id: string;
  user_id: string;
  expires_at: TimestampColumn;
  created_at: TimestampColumn;
}

export interface AuthAccountsTable {
  id: string;
  account_id: string;
  provider_id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: NullableTimestampColumn;
  refresh_token_expires_at: NullableTimestampColumn;
  scope: string | null;
  password: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface BetterAuthSessionsTable {
  id: string;
  expires_at: TimestampColumn;
  token: string;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
}

export interface AuthVerificationsTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: TimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface SharesTable {
  id: string;
  resource_type: string;
  resource_id: string;
  owner_user_id: string;
  grantee_user_id: string;
  level: ShareLevel;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface InstanceSettingsTable {
  key: string;
  value: JsonColumn;
  updated_by_user_id: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AdminAuditEventsTable {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: JsonColumn;
  request_id: string | null;
  created_at: TimestampColumn;
}

export interface ModuleEnablementTable {
  id: ColumnType<string, string | undefined, string>;
  scope: "instance" | "user";
  module_id: string;
  user_id: string | null;
  disabled_by_user_id: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

// External trusted-operator module enablement (#917). Instance-global, admin-managed.
// `'discovered'` is virtual (no row); only enabled/disabled/draft modules have a row.
// Backed by migration 0152_external_modules.sql; distribution columns by 0162 (#964);
// draft status + owner by 0159 (#1753).
export interface ExternalModulesTable {
  id: string;
  status: "enabled" | "disabled" | "draft";
  manifest_hash: string;
  package_hash: string;
  disabled_reason: string | null;
  enabled_by: string | null;
  enabled_at: NullableTimestampColumn;
  // #1753: NULL for every enabled/disabled row, NOT NULL for every draft row (DB CHECK
  // enforces the pairing). The one admin-author a draft runs for alone.
  owner_user_id: string | null;
  // #964 distribution: staged-download intent (accepted by the boot reconcile),
  // purge marks (executed by the boot reconcile), and the last install failure.
  staged_version: string | null;
  staged_package_hash: string | null;
  staged_at: NullableTimestampColumn;
  staged_by: string | null;
  staged_source: "admin-download" | "compose-ensure" | null;
  purge_requested_at: NullableTimestampColumn;
  purge_requested_by: string | null;
  last_install_error: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

// #1754: a module build in progress — the plan, status, and cost a chat turn writes to
// start one. Never the generated code itself (that lives on disk, keyed by id).
export interface ModuleBuildsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: ColumnType<string, string, never>;
  conversation_id: string | null;
  status:
    | "planning"
    | "awaiting_plan_approval"
    | "building"
    | "awaiting_change"
    | "ready"
    | "failed"
    | "cancelled";
  plan: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >;
  step: string | null;
  module_id: string | null;
  fetched_urls: ColumnType<string[], string[] | undefined, string[]>;
  written_files: ColumnType<string[], string[] | undefined, string[]>;
  cost_cents: ColumnType<number, number | undefined, number>;
  error: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

/**
 * Module credential secrets (#918 Slice 2). encrypted_secret is an AES-256-GCM
 * EncryptedSecret envelope, nullable because revoke scrubs it in place
 * (app_runtime has no DELETE grant — protected table).
 */
export interface ModuleCredentialsTable {
  id: string;
  module_id: string;
  credential_id: string;
  scope: "instance" | "user";
  owner_user_id: string | null;
  display_name: string;
  encrypted_secret: JsonColumn | null;
  revoked_at: NullableTimestampColumn;
  created_by: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

/** Module KV storage (#918 Slice 2). value is plain module data, never secrets. */
export interface ModuleKvTable {
  id: string;
  module_id: string;
  namespace: string;
  scope: "instance" | "user";
  owner_user_id: string | null;
  key: string;
  value: JsonColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface RlsProbeItemsTable {
  id: string;
  owner_user_id: string;
  body: string;
  created_at: TimestampColumn;
}

export type TaskStatus = "todo" | "suggested" | "done" | "archived";
export type ShareLevel = "view" | "contribute" | "manage";
export type ConnectorProviderType = "calendar" | "email" | "google" | "imap";
export type ConnectorProviderStatus = "available" | "disabled";
export type ConnectorAccountStatus = "active" | "error" | "revoked";
export type ConnectorSyncStatus = "success" | "partial" | "failed";
export type AiProviderKind = "openai-compatible" | "anthropic" | "google" | "ollama" | "custom";
export type AiProviderStatus = "active" | "error" | "disabled" | "revoked";
export type AiModelStatus = "active" | "disabled";
export type AiModelTier = "reasoning" | "interactive" | "economy";
// #2208: who created a model row. Discovery may prune only its own ('discovered') rows.
export type AiConfiguredModelOrigin = "discovered" | "manual";
export type AiAssistantActionRisk = "write" | "outbound" | "destructive";
export type AiAssistantActionStatus = "pending" | "confirmed" | "rejected" | "cancelled";
export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "stored" | "pending" | "blocked" | "no_model" | "working" | "error";
export type BriefingCadence = "manual" | "daily" | "weekly";
export type BriefingRunStatus = "succeeded" | "blocked" | "failed";
export type BriefingRunKind = "manual" | "scheduled";
export type BriefingType = "morning" | "evening" | "weekly_review";

export interface TasksTable {
  id: string;
  owner_user_id: string;
  list_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number | null;
  position: number;
  due_at: NullableTimestampColumn;
  do_at: NullableTimestampColumn;
  completed_at: NullableTimestampColumn;
  effort: "quick" | "medium" | "large" | null;
  source: string;
  source_ref: string | null;
  external_key: string | null;
  recurrence: Record<string, unknown> | null;
  recurrence_series_id: string | null;
  suggestion_metadata: Record<string, unknown> | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface ScratchpadsTable {
  user_id: string;
  body: string;
  revision: number;
  sync_to_notes: boolean;
  shortcut: string;
  updated_at: TimestampColumn;
}

export interface TaskActivityTable {
  id: string;
  task_id: string;
  actor_user_id: string;
  actor_kind: "user" | "jarvis" | "system";
  activity_type: string;
  body: string | null;
  created_at: TimestampColumn;
}

export interface TaskListsTable {
  id: string;
  owner_user_id: string;
  name: string;
  position: number;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface TaskTagsTable {
  id: string;
  owner_user_id: string;
  list_id: string;
  name: string;
  created_at: TimestampColumn;
}

export interface TaskTagAssignmentsTable {
  task_id: string;
  tag_id: string;
}

export interface TaskPreferencesTable {
  owner_user_id: string;
  default_view: "priority" | "matrix";
  updated_at: TimestampColumn;
}

export interface NotificationsTable {
  id: string;
  module_id: string | null;
  actor_user_id: string | null;
  recipient_user_id: string | null;
  title: string;
  body: string | null;
  metadata: JsonColumn;
  created_at: TimestampColumn;
  urgency: ColumnType<string, string | undefined, string>;
  deferred_until: NullableTimestampColumn;
  // Task 2b (#1283): event_key drives the partial unique index that makes a
  // re-posted ctx.notify.post key update its existing row instead of piling up
  // a duplicate; href is a same-origin path only (validated at the RPC boundary
  // and again here). Both null for every pre-existing, un-keyed notification.
  event_key: string | null;
  href: string | null;
  updated_at: TimestampColumn;
}

export interface NotificationReadsTable {
  notification_id: string;
  user_id: string;
  read_at: TimestampColumn;
}

export interface ConnectorDefinitionsTable {
  provider_id: string;
  provider_type: ConnectorProviderType;
  display_name: string;
  status: ConnectorProviderStatus;
  default_scopes: TextArrayColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface ConnectorAccountsTable {
  id: string;
  provider_id: string;
  owner_user_id: string;
  scopes: TextArrayColumn;
  status: ConnectorAccountStatus;
  encrypted_secret: JsonColumn;
  revoked_at: NullableTimestampColumn;
  last_sync_started_at: NullableTimestampColumn;
  last_sync_finished_at: NullableTimestampColumn;
  last_sync_status: ConnectorSyncStatus | null;
  last_sync_error: string | null;
  last_sync_counts: JsonColumn | null;
  last_sync_trigger: string | null;
  previous_sync: JsonColumn | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface ConnectorOauthPendingTable {
  id: string;
  owner_user_id: string;
  provider_id: string;
  state: string;
  encrypted_secret: JsonColumn;
  created_at: TimestampColumn;
}

export interface CalendarEventsTable {
  id: string;
  connector_account_id: string;
  owner_user_id: string;
  title: string;
  starts_at: TimestampColumn;
  ends_at: TimestampColumn;
  location: string | null;
  summary: string | null;
  body_excerpt: string | null;
  external_id: string;
  external_metadata: JsonColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface EmailMessagesTable {
  id: string;
  connector_account_id: string;
  owner_user_id: string;
  sender: string;
  recipients: TextArrayColumn;
  subject: string;
  snippet: string | null;
  body_excerpt: string | null;
  received_at: TimestampColumn;
  external_id: string;
  external_metadata: JsonColumn;
  // app.email_messages (Phase 3 connector-sync): LLM-derived triage columns.
  // summary is nullable text; signals is a jsonb object (NOT NULL DEFAULT '{}'),
  // hence JsonColumn so it can be omitted on insert (DB default applies). The full
  // email body is NEVER a column (privacy posture, spec §6).
  summary: string | null;
  signals: JsonColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export type TriageFeedbackVerdict = "accepted" | "rejected";

// app.email_triage_feedback (#729 §6): accept/reject learning signals for email triage
// suggestions. Owner-only under FORCE RLS; no email bodies — subject_prefix is writer-capped.
export interface EmailTriageFeedbackTable {
  id: string;
  owner_user_id: string;
  connector_account_id: string | null;
  source: string;
  actionability: string;
  sender: string;
  sender_domain: string;
  subject_prefix: string | null;
  action_type: string | null;
  confidence: number | null;
  model_version: string | null;
  verdict: TriageFeedbackVerdict;
  reason: string | null;
  created_at: TimestampColumn;
}

export interface EmailActionSuppressionTable {
  owner_user_id: string;
  subject_signature: string;
  dismissal_count: number;
  last_deadline_evidence_key: string | null;
  last_context_message_key: string | null;
  updated_at: TimestampColumn;
}

export interface EmailActionSuppressionEvidenceTable {
  owner_user_id: string;
  subject_signature: string;
  evidence_kind: "deadline" | "context";
  evidence_key: string;
  created_at: TimestampColumn;
}

export type AiAuthMethod = "cli" | "api_key";

type AiProviderPurpose = "assistant" | "voice"; // #874 (migration 0149): chat provider vs voice(STT)

export interface AiProviderConfigsTable {
  id: string;
  owner_user_id: string;
  provider_kind: AiProviderKind;
  display_name: string;
  base_url: string | null;
  status: AiProviderStatus;
  auth_method: AiAuthMethod;
  execution_mode: "interactive" | "non_interactive";
  // #874 (migration 0149): 'assistant' vs the single 'voice' STT endpoint; DB default backfills.
  purpose: ColumnType<AiProviderPurpose, AiProviderPurpose | undefined, AiProviderPurpose>;
  // #870/H1 (migration 0147): instance-default flag, at most one true (partial unique index).
  is_instance_default: ColumnType<boolean, boolean | undefined, boolean>;
  encrypted_credential: JsonColumn;
  revoked_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AiConfiguredModelsTable {
  id: string;
  provider_config_id: string;
  owner_user_id: string;
  provider_model_id: string;
  display_name: string;
  capabilities: TextArrayColumn;
  status: AiModelStatus;
  tier: AiModelTier;
  allow_user_override: ColumnType<boolean, boolean | undefined, boolean>;
  origin: ColumnType<
    AiConfiguredModelOrigin,
    AiConfiguredModelOrigin | undefined,
    AiConfiguredModelOrigin
  >;
  /** The provider's own release date for the model when its list gives one; null otherwise. */
  released_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AiAssistantActionRequestsTable {
  id: string;
  owner_user_id: string;
  tool_module_id: string;
  tool_module_name: string;
  tool_name: string;
  permission_id: string;
  risk: AiAssistantActionRisk;
  status: AiAssistantActionStatus;
  input_summary: JsonColumn;
  request_id: string | null;
  requested_at: TimestampColumn;
  resolved_at: NullableTimestampColumn;
  updated_at: TimestampColumn;
}

export interface MossActionAuditLogTable {
  id: string;
  owner_user_id: string;
  tool_module_id: string;
  tool_name: string;
  action_family_id: string | null;
  action_kind: string;
  approval_mode: string;
  outcome: string;
  error_class: string | null;
  request_id: string | null;
  chat_session_id: string | null;
  source_surface: string;
  input_summary: JsonColumn | null;
  occurred_at: TimestampColumn;
  duration_ms: number | null;
}

export interface MossErrorLogTable {
  id: string;
  owner_user_id: string | null;
  occurred_at: TimestampColumn;
  feature: string;
  operation: string;
  error_category: string;
  retryable: boolean;
  user_message: string;
  internal_summary: string;
  request_id: string | null;
}

export interface ChatThreadsTable {
  id: string;
  owner_user_id: string;
  title: string;
  surface: string;
  incognito: boolean;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  last_active_at: TimestampColumn;
  conversation_summary: string | null;
}

export interface ChatMessagesTable {
  id: string;
  thread_id: string;
  owner_user_id: string;
  role: ChatMessageRole;
  status: ChatMessageStatus;
  body: string;
  model_metadata: JsonColumn;
  tool_metadata: JsonColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export type ChatSkillSource = "authored" | "uploaded";

export interface ChatSkillsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  name: string;
  description: string | null;
  frontmatter: JsonColumn;
  body: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  source: ChatSkillSource;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface BriefingDefinitionsTable {
  id: string;
  owner_user_id: string;
  title: string;
  briefing_type: BriefingType;
  cadence: BriefingCadence;
  schedule_metadata: JsonColumn;
  enabled: boolean;
  selected_tool_names: TextArrayColumn;
  last_run_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface BriefingRunsTable {
  id: string;
  definition_id: string;
  owner_user_id: string;
  status: BriefingRunStatus;
  run_kind: BriefingRunKind;
  briefing_type: BriefingType;
  summary_text: string;
  source_metadata: JsonColumn;
  created_at: TimestampColumn;
}

export type UsefulnessFeedbackTargetKind =
  | "chat_message"
  | "briefing_run"
  | "briefing_item"
  | "proactive_card"
  | "news_story"
  | "sports_story";
export type UsefulnessFeedbackSurface =
  | "chat"
  | "briefing"
  | "today"
  | "proactive"
  | "news"
  | "sports";
export type UsefulnessFeedbackKind =
  | "more_like_this"
  | "less_like_this"
  | "too_much"
  | "wrong_priority"
  | "not_useful"
  | "remember_this"
  | "dismiss";
export type UsefulnessFeedbackStatus = "active" | "undone" | "superseded";
export type UsefulnessFeedbackPriorityBand = "critical" | "high" | "normal" | "low";

export interface UsefulnessFeedbackSignalsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: string;
  target_kind: UsefulnessFeedbackTargetKind;
  target_ref: string;
  surface: UsefulnessFeedbackSurface;
  kind: UsefulnessFeedbackKind;
  source_kind: string | null;
  source_label: string | null;
  priority_band: UsefulnessFeedbackPriorityBand | null;
  effect_kind: string | null;
  effect_ref: string | null;
  metadata_json: JsonColumn;
  status: ColumnType<
    UsefulnessFeedbackStatus,
    UsefulnessFeedbackStatus | undefined,
    UsefulnessFeedbackStatus
  >;
  /** Bounded free text, required for `less_like_this` and forbidden for every other action. */
  reason_text: string | null;
  /** Compiled relevance rule. Written by #2017 (906-B); always `{}` in this slice. */
  rule_json: JsonColumn;
  /** Version of the rule compiler that produced `rule_json`. Null until #2017 fills it. */
  rule_version: number | null;
  revision: ColumnType<number, number | undefined, number>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  resolved_at: NullableTimestampColumn;
}

export interface UsefulnessFeedbackTargetsTable {
  owner_user_id: string;
  target_kind: UsefulnessFeedbackTargetKind;
  target_ref: string;
  surface: UsefulnessFeedbackSurface;
  source_kind: string | null;
  source_label: string | null;
  priority_band: UsefulnessFeedbackPriorityBand | null;
  metadata_json: JsonColumn;
  last_seen_at: TimestampColumn;
}

export interface MemoryChunksTable {
  id: string;
  owner_user_id: string;
  source_kind: "vault" | "connector";
  source_path: string;
  line_start: number;
  line_end: number;
  content_hash: string;
  text: string;
  embedding: string | null; // pgvector stored as text in Kysely; serialized as "[n,n,...]"
  embed_model_name: string | null;
  embed_model_version: string | null;
  updated_at: TimestampColumn;
}

export interface MemoryLinksTable {
  id: string;
  owner_user_id: string;
  from_path: string;
  to_path: string;
}

export interface MemoryFileIndexTable {
  id: string;
  owner_user_id: string;
  source_kind: "vault" | "connector";
  source_path: string;
  file_hash: string;
  chunk_count: number;
  embed_model_name: string;
  embed_model_version: string;
  ingested_at: TimestampColumn;
}

export interface CommitmentsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  title: string;
  counterparty: string | null;
  due_at: NullableTimestampColumn;
  status: ColumnType<
    "open" | "at_risk" | "slipped" | "done" | "renegotiated" | "dismissed",
    "open" | "at_risk" | "slipped" | "done" | "renegotiated" | "dismissed" | undefined,
    "open" | "at_risk" | "slipped" | "done" | "renegotiated" | "dismissed"
  >;
  provenance: "volunteered" | "inferred" | "confirmed";
  source_kind: ColumnType<
    "manual" | "inferred" | "email" | "calendar",
    "manual" | "inferred" | "email" | "calendar" | undefined,
    "manual" | "inferred" | "email" | "calendar"
  >;
  source_ref: string | null;
  surfaced_state: string | null;
  life_area: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface EntitiesTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  type: "person" | "organization" | "account";
  name: string;
  attributes: JsonColumn;
  provenance: "volunteered" | "inferred" | "confirmed";
  vault_note_path: string | null;
  connector_refs: JsonColumn | null;
  life_area: string | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface PreferencesTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  key: string;
  value_json: JsonColumn;
  revision: ColumnType<number, number | undefined, number>;
  updated_at: TimestampColumn;
}

export type WellnessEmotionCore = "happy" | "sad" | "fear" | "anger" | "disgust" | "surprise";

export interface WellnessCheckinsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  checked_in_at: TimestampColumn;
  feeling_core: WellnessEmotionCore;
  feeling_secondary: string | null;
  feeling_tertiary: string | null;
  wheel_version: ColumnType<string, string | undefined, string>;
  sensations: TextArrayColumn;
  intensity: number | null;
  energy: number | null;
  note: string | null;
  identified_via: ColumnType<
    "wheel" | "assisted",
    "wheel" | "assisted" | undefined,
    "wheel" | "assisted"
  >;
  // `local_date` (YYYY-MM-DD) + `timezone_offset` (minutes east of UTC) are the #326/#771
  // day-boundary remediation columns: the caller's calendar day at check-in time, derived via
  // `resolveRouteTimeZone` on write. `local_date` is nullable only for rows that predate the
  // write-path fix; going forward every insert supplies both.
  local_date: string | null;
  timezone_offset: ColumnType<number, number | undefined, number>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export type MedicationFrequencyType =
  | "once_daily"
  | "times_per_day"
  | "specific_weekdays"
  | "every_n_hours"
  | "as_needed"
  | "cyclical"
  | "every_interval"
  | "monthly";
export type MedicationLogStatus = "taken" | "skipped" | "prn";

export interface MedicationsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  name: string;
  dosage: string | null;
  form: string | null;
  frequency_type: MedicationFrequencyType;
  times_per_day: number | null;
  interval_hours: number | null;
  weekdays: NullableNumberArrayColumn;
  schedule_times: NullableTextArrayColumn;
  cycle_days_on: number | null;
  cycle_days_off: number | null;
  cycle_anchor_date: ColumnType<string | null, string | null | undefined, string | null>;
  active: ColumnType<boolean, boolean | undefined, boolean>;
  notes: string | null;
  schedule_start_date: ColumnType<string | null, string | null | undefined, string | null>;
  schedule_end_date: ColumnType<string | null, string | null | undefined, string | null>;
  time_zone: string | null;
  interval_unit: "days" | "weeks" | "months" | null;
  interval_count: number | null;
  month_kind: "date" | "weekdayPosition" | null;
  month_day: number | null;
  month_day_is_last: ColumnType<boolean, boolean | undefined, boolean>;
  month_weekday_position: "first" | "second" | "third" | "fourth" | "last" | null;
  month_weekday: number | null;
  reminders_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface MedicationLogsTable {
  id: ColumnType<string, string | undefined, string>;
  medication_id: string;
  owner_user_id: string;
  status: MedicationLogStatus;
  dose: string | null;
  prn_reason: string | null;
  scheduled_for: NullableTimestampColumn;
  logged_at: TimestampColumn;
  created_at: TimestampColumn;
}

export interface WellnessTherapyNotesTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  body: string;
  linked_checkin_id: string | null;
  linked_emotion: WellnessEmotionCore | null;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export type DataExportJobStatus = "pending" | "building" | "ready" | "failed" | "expired";

export type DataExportJobFormat = "json" | "html";

export interface DataExportJobsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: ColumnType<string, string, never>;
  status: ColumnType<DataExportJobStatus, DataExportJobStatus | undefined, DataExportJobStatus>;
  created_at: TimestampColumn;
  completed_at: TimestampColumn | null;
  expires_at: TimestampColumn | null;
  error_message: string | null;
  format: ColumnType<DataExportJobFormat, DataExportJobFormat | undefined, DataExportJobFormat>;
  params: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | undefined,
    Record<string, unknown> | null
  >;
}

export interface ProactiveMonitorStateTable {
  owner_user_id: ColumnType<string, string, never>;
  source: string;
  cursor_json: JsonColumn;
  last_checked_at: NullableTimestampColumn;
  failure_count: ColumnType<number, number | undefined, number>;
  last_error_class: string | null;
  updated_at: TimestampColumn;
}

export type ProactiveCardStatusDb = "active" | "dismissed" | "expired" | "suppressed";

export interface ProactiveCardsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: ColumnType<string, string, never>;
  source: string;
  stable_key: string;
  source_ref_hash: string;
  title: string;
  summary: string;
  signal_type: string;
  priority_band: ColumnType<
    "critical" | "high" | "normal" | "low",
    "critical" | "high" | "normal" | "low",
    "critical" | "high" | "normal" | "low"
  >;
  priority_reasons: ColumnType<readonly string[], readonly string[] | undefined, readonly string[]>;
  status: ColumnType<
    ProactiveCardStatusDb,
    ProactiveCardStatusDb | undefined,
    ProactiveCardStatusDb
  >;
  occurred_at: NullableTimestampColumn;
  target_at: NullableTimestampColumn;
  first_seen_at: TimestampColumn;
  last_seen_at: TimestampColumn;
  deferred_until: NullableTimestampColumn;
  expires_at: NullableTimestampColumn;
  dismissed_at: NullableTimestampColumn;
  metadata_json: JsonColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

type CommitmentCandidateKindDb = "deadline" | "promise" | "obligation" | "intent";
type CommitmentCandidateStatusDb =
  | "pending_review"
  | "accepted"
  | "rejected"
  | "snoozed"
  | "expired"
  | "explicit_non_action";
type CommitmentSuggestedHandlingDb =
  | "create_task"
  | "create_goal"
  | "create_calendar_event"
  | "send_reply"
  | "dismiss";

export interface CommitmentCandidatesTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: string;
  candidate_signature: string;
  kind: ColumnType<CommitmentCandidateKindDb, CommitmentCandidateKindDb, CommitmentCandidateKindDb>;
  title: string;
  due_local_date: ColumnType<string | null, string | null | undefined, string | null>;
  counterparty_label: ColumnType<string | null, string | null | undefined, string | null>;
  status: ColumnType<
    CommitmentCandidateStatusDb,
    CommitmentCandidateStatusDb | undefined,
    CommitmentCandidateStatusDb
  >;
  confidence: ColumnType<
    "high" | "medium" | "low",
    "high" | "medium" | "low",
    "high" | "medium" | "low"
  >;
  suggested_handling: ColumnType<
    CommitmentSuggestedHandlingDb | null,
    CommitmentSuggestedHandlingDb | null | undefined,
    CommitmentSuggestedHandlingDb | null
  >;
  resolution_ref: ColumnType<string | null, string | null | undefined, string | null>;
  suppressed_by: ColumnType<string | null, string | null | undefined, string | null>;
  source_count: ColumnType<number, number | undefined, number>;
  first_seen_at: TimestampColumn;
  last_seen_at: TimestampColumn;
  snoozed_until: NullableTimestampColumn;
  expires_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
  // 0221 (email chief of staff): email-thread candidates. thread_ref is unique per owner; the
  // judgement never stores a body, only the capped why lines and the proposed actions.
  counterparty_person_id: ColumnType<string | null, string | null | undefined, string | null>;
  counterparty_address: ColumnType<string | null, string | null | undefined, string | null>;
  proposed_actions: JsonColumn;
  why_lines: ColumnType<string[], string[] | undefined, string[]>;
  thread_ref: ColumnType<string | null, string | null | undefined, string | null>;
  last_judged_external_id: ColumnType<string | null, string | null | undefined, string | null>;
  stale: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface CommitmentEmailThreadJudgementsTable {
  owner_user_id: string;
  thread_ref: string;
  last_judged_external_id: string;
  outcome: "no_item" | "item";
  judged_at: TimestampColumn;
}

export interface CommitmentCandidateSourcesTable {
  id: ColumnType<string, string | undefined, never>;
  candidate_id: string;
  owner_user_id: string;
  source_kind: "chat" | "email" | "notes";
  source_ref: string;
  source_version: ColumnType<number, number | undefined, number>;
  evidence_excerpt: string;
  occurred_at: NullableTimestampColumn;
  created_at: TimestampColumn;
}

export interface CommitmentCandidateEventsTable {
  id: ColumnType<string, string | undefined, never>;
  candidate_id: string;
  owner_user_id: string;
  event_kind:
    | "created"
    | "status_changed"
    | "resolution_set"
    | "snoozed"
    | "suppressed"
    | "evidence_added";
  from_status: ColumnType<
    CommitmentCandidateStatusDb | null,
    CommitmentCandidateStatusDb | null | undefined,
    CommitmentCandidateStatusDb | null
  >;
  to_status: ColumnType<
    CommitmentCandidateStatusDb | null,
    CommitmentCandidateStatusDb | null | undefined,
    CommitmentCandidateStatusDb | null
  >;
  actor_user_id: string;
  detail: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >;
  created_at: TimestampColumn;
}

export interface CommitmentExtractionStateTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: string;
  source_kind: "chat" | "email" | "notes";
  last_extracted_at: NullableTimestampColumn;
  last_run_at: TimestampColumn;
  updated_at: TimestampColumn;
}

// Workflow persistence (#2013, slice 819-B). Mirrors
// packages/workflows/sql/0202_workflow_runs.sql. Status columns are TEXT + CHECK in the
// database, so the union alias here is the only place the allowed values are named in
// TypeScript.
type WorkflowRunStatusDb =
  | "pending"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";
type WorkflowStepRunStatusDb =
  | "pending"
  | "queued"
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";
type WorkflowApprovalStatusDb = "pending" | "approved" | "denied" | "cancelled";
type WorkflowRunStartedByDb = "user" | "module" | "system";

export interface WorkflowRunsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_user_id: string;
  workflow_id: string;
  workflow_version: number;
  module_id: string;
  status: ColumnType<WorkflowRunStatusDb, WorkflowRunStatusDb | undefined, WorkflowRunStatusDb>;
  started_by: WorkflowRunStartedByDb;
  input_json: JsonColumn;
  result_json: JsonColumn;
  started_at: TimestampColumn;
  completed_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface WorkflowStepRunsTable {
  id: ColumnType<string, string | undefined, never>;
  workflow_run_id: string;
  owner_user_id: string;
  step_id: string;
  status: ColumnType<
    WorkflowStepRunStatusDb,
    WorkflowStepRunStatusDb | undefined,
    WorkflowStepRunStatusDb
  >;
  attempt_count: ColumnType<number, number | undefined, number>;
  input_json: JsonColumn;
  result_json: JsonColumn;
  error_code: ColumnType<string | null, string | null | undefined, string | null>;
  pgboss_job_id: ColumnType<string | null, string | null | undefined, string | null>;
  started_at: NullableTimestampColumn;
  suspended_at: NullableTimestampColumn;
  completed_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface WorkflowApprovalsTable {
  id: ColumnType<string, string | undefined, never>;
  workflow_run_id: string;
  step_run_id: string;
  owner_user_id: string;
  status: ColumnType<
    WorkflowApprovalStatusDb,
    WorkflowApprovalStatusDb | undefined,
    WorkflowApprovalStatusDb
  >;
  summary: string;
  details_json: JsonColumn;
  resolved_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface WorkflowArtifactsTable {
  id: ColumnType<string, string | undefined, never>;
  workflow_run_id: string;
  step_run_id: ColumnType<string | null, string | null | undefined, string | null>;
  owner_user_id: string;
  artifact_ref: string;
  sha256: string;
  content_type: string;
  // BIGINT: node-postgres hands back a string, and callers pass a number on write.
  size_bytes: ColumnType<string, number | string, number | string>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export type {
  WorkflowRunStatusDb,
  WorkflowStepRunStatusDb,
  WorkflowApprovalStatusDb,
  WorkflowRunStartedByDb
};

export type {
  PersonContextStatusDb,
  PersonContextIdentityKindDb,
  PersonContextSourceKindDb,
  PersonContextIdentityStatusDb,
  PersonContextProvenanceDb,
  PersonContextLinkKindDb,
  PersonContextCandidateKindDb,
  PersonContextCandidateStatusDb,
  PersonContextEventKindDb,
  PersonContextPeopleTable,
  PersonContextIdentitiesTable,
  PersonContextLinksTable,
  PersonContextLinkSourcesTable,
  PersonContextMatchCandidatesTable,
  PersonContextEventsTable,
  PersonContextIndexingStateTable,
  PersonContextPerson,
  PersonContextIdentity,
  PersonContextLink,
  PersonContextLinkSource,
  PersonContextMatchCandidate,
  PersonContextEvent,
  PersonContextIndexingState
} from "./people-types.js";
import type {
  PersonContextPeopleTable,
  PersonContextIdentitiesTable,
  PersonContextLinksTable,
  PersonContextLinkSourcesTable,
  PersonContextMatchCandidatesTable,
  PersonContextEventsTable,
  PersonContextIndexingStateTable
} from "./people-types.js";

export interface SportsFollowsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  competition_key: string;
  // The team's short name, for display and for suggesting candidates in the one-time "which team
  // did you mean?" prompt. NULL still means "follow the whole competition". Never matched on.
  team_key: string | null;
  // The provider's permanent team id: the only identity used to match games, standings, briefing
  // facts and news (0217). NULL on a follow saved before that migration; such a row matches
  // nothing until the person picks a team.
  source_team_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TimestampColumn;
}

export interface NewsPrefsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  kind: "source" | "source_exclude" | "topic";
  key: string;
  created_at: TimestampColumn;
}

// #953 News Slice 1 personalization tables (0159_news_personalization.sql). All owner-only
// under FORCE RLS; validation_fingerprint is an opaque revalidation marker, never a
// provider/model identity. Slice 2 owns source/topic writes; Slice 1 reads/exports them.
export type NewsValidationStatus = "approved" | "needs_revalidation" | "rejected";

export interface NewsCustomSourcesTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  label: string;
  canonical_domain: string;
  homepage_url: string;
  feed_url: string | null;
  retrieval_method: "feed" | "scrape";
  validation_status: NewsValidationStatus;
  health_status:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "unsupported"
    | "disabled";
  validation_fingerprint: string;
  validated_at: TimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

/**
 * News publisher credentials (#2005). One row per (owner, custom source); a source
 * with no credential simply has no row. encrypted_secret is an AES-256-GCM envelope
 * produced in the composition root — News never resolves key material itself.
 * generation is bigint, which the pg driver returns as a string.
 */
export interface NewsSourceCredentialsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  source_id: string;
  connection_id: string;
  encrypted_secret: JsonColumn | null;
  status: "configured" | "revoked";
  generation: ColumnType<string, string | undefined, string>;
  last_validated_at: NullableTimestampColumn;
  revoked_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface NewsCustomTopicsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  label: string;
  guidance: string | null;
  validation_status: NewsValidationStatus;
  validation_fingerprint: string;
  validated_at: TimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface NewsSourceExclusionsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  canonical_domain: string;
  created_at: TimestampColumn;
}

// Derived/transient compiled-feed cache: one row per user (owner_user_id IS the primary
// key), replaced atomically, never exported. payload has no DB default — writers must
// always supply a value the News-owned assertSnapshotPayload has accepted.
export interface NewsCompilationSnapshotsTable {
  owner_user_id: string;
  compiled_at: TimestampColumn;
  expires_at: TimestampColumn;
  payload: ColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface NewsRefreshStateTable {
  owner_user_id: string;
  state: "idle" | "queued" | "running" | "failed";
  failure_kind: "fetch" | "ai" | "internal" | null;
  requested_generation: ColumnType<string, string | number | undefined, string | number>;
  compiled_generation: ColumnType<string, string | number | undefined, string | number>;
  updated_at: TimestampColumn;
  /**
   * #2030 — history, not live status. `state` and `failure_kind` above say what is true right
   * now; these five say when each event last happened, ever. A later success clears
   * `failure_kind` but must leave `last_failure_at` / `last_failure_kind` alone.
   */
  last_requested_at: TimestampColumn | null;
  last_attempt_at: TimestampColumn | null;
  last_success_at: TimestampColumn | null;
  last_failure_at: TimestampColumn | null;
  last_failure_kind: "fetch" | "ai" | "internal" | null;
}

export interface NewsPolicyVerdictsTable {
  owner_user_id: string;
  canonical_domain: string;
  fingerprint: string;
  verdict: "approved" | "rejected";
  decided_at: TimestampColumn;
  expires_at: TimestampColumn;
}

// #1572 Sports custom news source tables (0190_sports_custom_sources.sql). Owner-only under
// FORCE RLS; no worker grants — headlines are fetched synchronously, not by a background job.
export type SportsSourceHealthState =
  | "pending"
  | "healthy"
  | "failing"
  | "unsupported"
  | "auth_required"
  | "disabled";

export interface SportsCustomSourcesTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  label: string;
  canonical_domain: string;
  homepage_url: string;
  feed_url: string | null;
  retrieval_method: "feed" | "scrape" | "reddit";
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  health_state: ColumnType<
    SportsSourceHealthState,
    SportsSourceHealthState | undefined,
    SportsSourceHealthState
  >;
  health_reason_code: string | null;
  health_message: string | null;
  last_checked_at: TimestampColumn | null;
  last_success_at: TimestampColumn | null;
  validation_fingerprint: string;
  validated_at: TimestampColumn;
  recipe_json: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >;
  recipe_schema_version: 1 | null;
  recipe_fingerprint: string | null;
  recipe_status: ColumnType<
    "feed" | "ready" | "missing" | "drift",
    "feed" | "ready" | "missing" | "drift" | undefined,
    "feed" | "ready" | "missing" | "drift"
  >;
  confirmed_fetch_hosts: string[];
  authorization_confirmed_at: TimestampColumn;
  /** #2211 (0213): a subreddit's community icon URL on Reddit's image hosts; null for publications. */
  icon_url: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface SportsSourceAssignmentsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  source_id: string;
  follow_id: string | null;
  sport_key: string | null;
  target_url: string | null;
  target_parameters: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  preview_status: ColumnType<
    "pending" | "verified" | "recipe_missing",
    "pending" | "verified" | "recipe_missing" | undefined,
    "pending" | "verified" | "recipe_missing"
  >;
  health_state: ColumnType<
    SportsSourceHealthState,
    SportsSourceHealthState | undefined,
    SportsSourceHealthState
  >;
  health_reason_code: string | null;
  health_message: string | null;
  last_checked_at: TimestampColumn | null;
  last_success_at: TimestampColumn | null;
  created_at: TimestampColumn;
}

export interface SportsEspnSourceAssignmentsTable {
  id: ColumnType<string, string | undefined, string>;
  owner_user_id: string;
  sport_key: string | null;
  follow_id: string | null;
  created_at: TimestampColumn;
}

export interface SportsPolicyVerdictsTable {
  owner_user_id: string;
  canonical_domain: string;
  fingerprint: string;
  verdict: "approved" | "rejected";
  decided_at: TimestampColumn;
  expires_at: TimestampColumn;
}

export interface SportsHeadlinePrefsTable {
  owner_user_id: string;
  espn_headlines_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: TimestampColumn;
}

export interface MossDatabase {
  "app.schema_migrations": SchemaMigrationsTable;
  "app.users": UsersTable;
  "app.member_onboarding": MemberOnboardingTable;
  "app.provider_install_state": ProviderInstallStateTable;
  "app.auth_sessions": AuthSessionsTable;
  "app.auth_accounts": AuthAccountsTable;
  "app.better_auth_sessions": BetterAuthSessionsTable;
  "app.auth_verifications": AuthVerificationsTable;
  "app.shares": SharesTable;
  "app.instance_settings": InstanceSettingsTable;
  "app.admin_audit_events": AdminAuditEventsTable;
  "app.module_enablement": ModuleEnablementTable;
  "app.external_modules": ExternalModulesTable;
  "app.module_builds": ModuleBuildsTable;
  "app.module_credentials": ModuleCredentialsTable;
  "app.module_kv": ModuleKvTable;
  "app.rls_probe_items": RlsProbeItemsTable;
  "app.tasks": TasksTable;
  "app.scratchpads": ScratchpadsTable;
  "app.task_activity": TaskActivityTable;
  "app.task_lists": TaskListsTable;
  "app.task_tags": TaskTagsTable;
  "app.task_tag_assignments": TaskTagAssignmentsTable;
  "app.task_preferences": TaskPreferencesTable;
  "app.notifications": NotificationsTable;
  "app.notification_reads": NotificationReadsTable;
  "app.connector_definitions": ConnectorDefinitionsTable;
  "app.connector_accounts": ConnectorAccountsTable;
  "app.connector_oauth_pending": ConnectorOauthPendingTable;
  "app.calendar_events": CalendarEventsTable;
  "app.email_messages": EmailMessagesTable;
  "app.email_triage_feedback": EmailTriageFeedbackTable;
  "app.email_action_suppression": EmailActionSuppressionTable;
  "app.email_action_suppression_evidence": EmailActionSuppressionEvidenceTable;
  "app.ai_provider_configs": AiProviderConfigsTable;
  "app.ai_configured_models": AiConfiguredModelsTable;
  "app.ai_assistant_action_requests": AiAssistantActionRequestsTable;
  "app.moss_action_audit_log": MossActionAuditLogTable;
  "app.moss_error_log": MossErrorLogTable;
  "app.chat_threads": ChatThreadsTable;
  "app.chat_messages": ChatMessagesTable;
  "app.chat_skills": ChatSkillsTable;
  "app.briefing_definitions": BriefingDefinitionsTable;
  "app.briefing_runs": BriefingRunsTable;
  "app.usefulness_feedback_signals": UsefulnessFeedbackSignalsTable;
  "app.usefulness_feedback_targets": UsefulnessFeedbackTargetsTable;
  "app.memory_chunks": MemoryChunksTable;
  "app.memory_links": MemoryLinksTable;
  "app.memory_file_index": MemoryFileIndexTable;
  "app.commitments": CommitmentsTable;
  "app.entities": EntitiesTable;
  "app.preferences": PreferencesTable;
  "app.wellness_checkins": WellnessCheckinsTable;
  "app.sports_follows": SportsFollowsTable;
  "app.sports_custom_sources": SportsCustomSourcesTable;
  "app.sports_source_assignments": SportsSourceAssignmentsTable;
  "app.sports_espn_source_assignments": SportsEspnSourceAssignmentsTable;
  "app.sports_policy_verdicts": SportsPolicyVerdictsTable;
  "app.sports_headline_prefs": SportsHeadlinePrefsTable;
  "app.news_prefs": NewsPrefsTable;
  "app.news_custom_sources": NewsCustomSourcesTable;
  "app.news_custom_topics": NewsCustomTopicsTable;
  "app.news_source_exclusions": NewsSourceExclusionsTable;
  "app.news_compilation_snapshots": NewsCompilationSnapshotsTable;
  "app.news_refresh_state": NewsRefreshStateTable;
  "app.news_policy_verdicts": NewsPolicyVerdictsTable;
  "app.news_source_credentials": NewsSourceCredentialsTable;
  "app.medications": MedicationsTable;
  "app.medication_logs": MedicationLogsTable;
  "app.wellness_therapy_notes": WellnessTherapyNotesTable;
  "app.data_export_jobs": DataExportJobsTable;
  "app.proactive_monitor_state": ProactiveMonitorStateTable;
  "app.proactive_cards": ProactiveCardsTable;
  "app.commitment_candidates": CommitmentCandidatesTable;
  "app.commitment_candidate_sources": CommitmentCandidateSourcesTable;
  "app.commitment_candidate_events": CommitmentCandidateEventsTable;
  "app.commitment_extraction_state": CommitmentExtractionStateTable;
  "app.commitment_email_thread_judgements": CommitmentEmailThreadJudgementsTable;
  "app.workflow_runs": WorkflowRunsTable;
  "app.workflow_step_runs": WorkflowStepRunsTable;
  "app.workflow_approvals": WorkflowApprovalsTable;
  "app.workflow_artifacts": WorkflowArtifactsTable;
  "app.person_context_people": PersonContextPeopleTable;
  "app.person_context_identities": PersonContextIdentitiesTable;
  "app.person_context_links": PersonContextLinksTable;
  "app.person_context_link_sources": PersonContextLinkSourcesTable;
  "app.person_context_match_candidates": PersonContextMatchCandidatesTable;
  "app.person_context_events": PersonContextEventsTable;
  "app.person_context_indexing_state": PersonContextIndexingStateTable;
}

export type User = Selectable<UsersTable>;
export type Share = Selectable<SharesTable>;
export type InstanceSetting = Selectable<InstanceSettingsTable>;
export type AdminAuditEvent = Selectable<AdminAuditEventsTable>;
export type ModuleEnablementRow = Selectable<ModuleEnablementTable>;
export type ExternalModuleRow = Selectable<ExternalModulesTable>;
export type RlsProbeItem = Selectable<RlsProbeItemsTable>;
export type Task = Selectable<TasksTable>;
export type Scratchpad = Selectable<ScratchpadsTable>;
export type EmailActionSuppression = Selectable<EmailActionSuppressionTable>;
export type EmailActionSuppressionEvidence = Selectable<EmailActionSuppressionEvidenceTable>;
export type TaskActivity = Selectable<TaskActivityTable>;
export type TaskList = Selectable<TaskListsTable>;
export type TaskTag = Selectable<TaskTagsTable>;
export type TaskPreferences = Selectable<TaskPreferencesTable>;
export type Notification = Selectable<NotificationsTable>;
export type ConnectorProvider = Selectable<ConnectorDefinitionsTable>;
export type CalendarEvent = Selectable<CalendarEventsTable>;
export type EmailMessage = Selectable<EmailMessagesTable>;
export type AiAssistantActionRequest = Selectable<AiAssistantActionRequestsTable>;
export type MossActionAuditLog = Selectable<MossActionAuditLogTable>;
export type MossErrorLog = Selectable<MossErrorLogTable>;
export type ChatThread = Selectable<ChatThreadsTable>;
export type ChatMessage = Selectable<ChatMessagesTable>;
export type ChatSkill = Selectable<ChatSkillsTable>;
export type BriefingDefinition = Selectable<BriefingDefinitionsTable>;
export type BriefingRun = Selectable<BriefingRunsTable>;
export type UsefulnessFeedbackSignal = Selectable<UsefulnessFeedbackSignalsTable>;
export type Commitment = Selectable<CommitmentsTable>;
export type Entity = Selectable<EntitiesTable>;
export type WellnessCheckin = Selectable<WellnessCheckinsTable>;
export type Medication = Selectable<MedicationsTable>;
export type MedicationLog = Selectable<MedicationLogsTable>;
export type WellnessTherapyNote = Selectable<WellnessTherapyNotesTable>;
export type DataExportJob = Selectable<DataExportJobsTable>;
export type NewsCustomSource = Selectable<NewsCustomSourcesTable>;
export type NewsCustomTopic = Selectable<NewsCustomTopicsTable>;
export type NewsSourceExclusion = Selectable<NewsSourceExclusionsTable>;
export type NewsSourceCredential = Selectable<NewsSourceCredentialsTable>;
export type NewsCompilationSnapshot = Selectable<NewsCompilationSnapshotsTable>;
export type NewsRefreshState = Selectable<NewsRefreshStateTable>;
export type NewsPolicyVerdict = Selectable<NewsPolicyVerdictsTable>;
