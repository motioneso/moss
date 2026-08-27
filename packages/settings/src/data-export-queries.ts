import { sql } from "kysely";

// Per-table SQL builders for exportUserData (packages/settings/src/data-export.ts). Split into
// this file because the combined file exceeded the 1000-line check:file-size gate once #925
// (module credentials/KV) landed alongside #914's export wiring.

export function userQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      email,
      name,
      email_verified AS "emailVerified",
      image,
      is_instance_admin AS "isInstanceAdmin",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.users
    WHERE id = ${userId}::uuid
    ORDER BY id
  `;
}

export function authAccountsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      account_id AS "accountId",
      provider_id AS "providerId",
      user_id::text AS "userId",
      scope,
      access_token IS NOT NULL AS "hasAccessToken",
      refresh_token IS NOT NULL AS "hasRefreshToken",
      id_token IS NOT NULL AS "hasIdToken",
      password IS NOT NULL AS "hasPassword",
      access_token_expires_at AS "accessTokenExpiresAt",
      refresh_token_expires_at AS "refreshTokenExpiresAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.auth_accounts
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function betterAuthSessionsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      user_id::text AS "userId",
      expires_at AS "expiresAt",
      ip_address AS "ipAddress",
      user_agent AS "userAgent",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.better_auth_sessions
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function tasksQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      title,
      description,
      status::text,
      priority,
      due_at AS "dueAt",
      completed_at AS "completedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.tasks
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function taskActivityQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      activity.id::text AS id,
      activity.task_id::text AS "taskId",
      activity.actor_user_id::text AS "actorUserId",
      activity.activity_type AS "activityType",
      activity.body,
      activity.created_at AS "createdAt"
    FROM app.task_activity activity
    JOIN app.tasks task ON task.id = activity.task_id
    WHERE task.owner_user_id = ${userId}::uuid
    ORDER BY activity.created_at, activity.id
  `;
}

export function notificationsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      actor_user_id::text AS "actorUserId",
      recipient_user_id::text AS "recipientUserId",
      title,
      body,
      metadata,
      created_at AS "createdAt"
    FROM app.notifications
    WHERE recipient_user_id = ${userId}::uuid
      OR actor_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function notificationReadsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      notification_id::text AS "notificationId",
      user_id::text AS "userId",
      read_at AS "readAt"
    FROM app.notification_reads
    WHERE user_id = ${userId}::uuid
    ORDER BY read_at, notification_id
  `;
}

export function connectorAccountsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      provider_id AS "providerId",
      owner_user_id::text AS "ownerUserId",
      scopes,
      status::text,
      encrypted_secret IS NOT NULL AS "hasSecret",
      revoked_at AS "revokedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.connector_accounts
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function moduleCredentialsQuery(userId: string) {
  // SECURITY: metadata only — the AES-256-GCM envelope is NEVER exported.
  // hasSecret mirrors connectorAccountsQuery's `encrypted_secret IS NOT NULL`.
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      module_id AS "moduleId",
      credential_id AS "credentialId",
      scope,
      display_name AS "displayName",
      encrypted_secret IS NOT NULL AS "hasSecret",
      revoked_at AS "revokedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.module_credentials
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function moduleKvQuery(userId: string) {
  // KV values are the user's plain module data (not secrets) — exported directly.
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      module_id AS "moduleId",
      namespace,
      key,
      value,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.module_kv
    WHERE scope = 'user' AND owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function calendarEventsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      connector_account_id::text AS "connectorAccountId",
      owner_user_id::text AS "ownerUserId",
      title,
      starts_at AS "startsAt",
      ends_at AS "endsAt",
      location,
      summary,
      body_excerpt AS "bodyExcerpt",
      external_id AS "externalId",
      external_metadata AS "externalMetadata",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.calendar_events
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY starts_at, id
  `;
}

export function emailMessagesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      connector_account_id::text AS "connectorAccountId",
      owner_user_id::text AS "ownerUserId",
      sender,
      recipients,
      subject,
      snippet,
      body_excerpt AS "bodyExcerpt",
      summary,
      signals,
      received_at AS "receivedAt",
      external_id AS "externalId",
      external_metadata AS "externalMetadata",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.email_messages
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY received_at, id
  `;
}

export function aiProviderConfigsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      provider_kind::text AS "providerKind",
      display_name AS "displayName",
      base_url AS "baseUrl",
      status::text,
      encrypted_credential IS NOT NULL AS "hasCredential",
      revoked_at AS "revokedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.ai_provider_configs
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function aiConfiguredModelsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      provider_config_id::text AS "providerConfigId",
      owner_user_id::text AS "ownerUserId",
      provider_model_id AS "providerModelId",
      display_name AS "displayName",
      capabilities,
      status::text,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.ai_configured_models
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function aiAssistantActionRequestsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      tool_module_id AS "toolModuleId",
      tool_module_name AS "toolModuleName",
      tool_name AS "toolName",
      permission_id AS "permissionId",
      risk,
      status::text,
      input_summary AS "inputSummary",
      request_id AS "requestId",
      requested_at AS "requestedAt",
      resolved_at AS "resolvedAt",
      updated_at AS "updatedAt"
    FROM app.ai_assistant_action_requests
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY requested_at, id
  `;
}

export function jarvisActionAuditLogQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      tool_module_id AS "toolModuleId",
      tool_name AS "toolName",
      action_family_id AS "actionFamilyId",
      action_kind AS "actionKind",
      approval_mode AS "approvalMode",
      outcome,
      error_class AS "errorClass",
      request_id AS "requestId",
      chat_session_id AS "chatSessionId",
      source_surface AS "sourceSurface",
      input_summary AS "inputSummary",
      occurred_at AS "occurredAt"
    FROM app.moss_action_audit_log
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY occurred_at, id
  `;
}

export function chatThreadsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      title,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.chat_threads
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function chatMessagesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      thread_id::text AS "threadId",
      owner_user_id::text AS "ownerUserId",
      role::text,
      status::text,
      body,
      model_metadata AS "modelMetadata",
      tool_metadata AS "toolMetadata",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.chat_messages
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function briefingDefinitionsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      title,
      cadence::text,
      schedule_metadata AS "scheduleMetadata",
      enabled,
      selected_tool_names AS "selectedToolNames",
      last_run_at AS "lastRunAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.briefing_definitions
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function briefingRunsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      definition_id::text AS "definitionId",
      owner_user_id::text AS "ownerUserId",
      status::text,
      run_kind::text AS "runKind",
      summary_text AS "summaryText",
      source_metadata AS "sourceMetadata",
      created_at AS "createdAt"
    FROM app.briefing_runs
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryChunksQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      source_kind AS "sourceKind",
      source_path AS "sourcePath",
      line_start AS "lineStart",
      line_end AS "lineEnd",
      text,
      updated_at AS "updatedAt"
    FROM app.memory_chunks
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY source_path, line_start, id
  `;
}

export function chatMemoryFactsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      category,
      content,
      source_thread_id::text AS "sourceThreadId",
      importance,
      status,
      superseded_at AS "supersededAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.chat_memory_facts
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryEntitiesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      kind,
      name,
      summary,
      status,
      importance,
      pinned,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.memory_entities
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryFactsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      subject_entity_id::text AS "subjectEntityId",
      predicate,
      object_entity_id::text AS "objectEntityId",
      object_text AS "objectText",
      record_kind AS "recordKind",
      confidence,
      provenance,
      status,
      valid_from AS "validFrom",
      valid_to AS "validTo",
      stale_at AS "staleAt",
      superseded_by_fact_id::text AS "supersededByFactId",
      conflict_group_id::text AS "conflictGroupId",
      last_confirmed_at AS "lastConfirmedAt",
      importance,
      pinned,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.memory_facts
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryEpisodesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      source_kind AS "sourceKind",
      source_ref AS "sourceRef",
      source_label AS "sourceLabel",
      occurred_at AS "occurredAt",
      excerpt,
      created_at AS "createdAt"
    FROM app.memory_episodes
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryFactSourcesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      owner_user_id::text AS "ownerUserId",
      fact_id::text AS "factId",
      episode_id::text AS "episodeId",
      created_at AS "createdAt"
    FROM app.memory_fact_sources
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, fact_id, episode_id
  `;
}

export function memoryAliasesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      entity_id::text AS "entityId",
      alias,
      normalized_alias AS "normalizedAlias",
      ambiguous,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.memory_aliases
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryConflictGroupsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      owner_user_id::text AS "ownerUserId",
      id::text AS id,
      status,
      created_at AS "createdAt",
      resolved_at AS "resolvedAt"
    FROM app.memory_conflict_groups
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryCandidatesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      episode_id::text AS "episodeId",
      kind,
      action,
      payload_json - 'excerpt' AS "payloadJson",
      candidate_signature AS "candidateSignature",
      status,
      confidence,
      importance,
      provenance,
      promotion_reason AS "promotionReason",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      resolved_at AS "resolvedAt"
    FROM app.memory_candidates
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memorySearchDocumentsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      target_kind AS "targetKind",
      target_id::text AS "targetId",
      search_text AS "searchText",
      embed_model_name AS "embedModelName",
      embed_model_version AS "embedModelVersion",
      status,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.memory_search_documents
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function memoryLegacyFactMigrationsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      owner_user_id::text AS "ownerUserId",
      legacy_fact_id::text AS "legacyFactId",
      memory_fact_id::text AS "memoryFactId",
      created_at AS "createdAt"
    FROM app.memory_legacy_fact_migrations
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, legacy_fact_id
  `;
}

export function commitmentsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      title,
      counterparty,
      due_at AS "dueAt",
      status::text,
      provenance::text,
      source_kind::text AS "sourceKind",
      source_ref AS "sourceRef",
      surfaced_state AS "surfacedState",
      life_area AS "lifeArea",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.commitments
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function entitiesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      type::text,
      name,
      attributes,
      provenance::text,
      vault_note_path AS "vaultNotePath",
      connector_refs AS "connectorRefs",
      life_area AS "lifeArea",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.entities
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function preferencesQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      key,
      value_json AS "valueJson",
      updated_at AS "updatedAt"
    FROM app.preferences
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY key, id
  `;
}

export function usefulnessFeedbackSignalsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      target_kind AS "targetKind",
      target_ref AS "targetRef",
      surface,
      kind,
      source_kind AS "sourceKind",
      source_label AS "sourceLabel",
      priority_band AS "priorityBand",
      effect_kind AS "effectKind",
      effect_ref AS "effectRef",
      metadata_json AS "metadata",
      status,
      reason_text AS "reason",
      rule_json AS "rule",
      rule_version AS "ruleVersion",
      revision,
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      resolved_at AS "resolvedAt"
    FROM app.usefulness_feedback_signals
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function usefulnessFeedbackTargetsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      owner_user_id::text AS "ownerUserId",
      target_kind AS "targetKind",
      target_ref AS "targetRef",
      surface,
      source_kind AS "sourceKind",
      source_label AS "sourceLabel",
      priority_band AS "priorityBand",
      metadata_json AS "metadata",
      last_seen_at AS "lastSeenAt"
    FROM app.usefulness_feedback_targets
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY last_seen_at, target_kind, target_ref, surface
  `;
}

export function medicationsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      name,
      dosage,
      form,
      frequency_type::text AS "frequencyType",
      times_per_day AS "timesPerDay",
      interval_hours AS "intervalHours",
      weekdays,
      schedule_times AS "scheduleTimes",
      cycle_days_on AS "cycleDaysOn",
      cycle_days_off AS "cycleDaysOff",
      cycle_anchor_date::text AS "cycleAnchorDate",
      active,
      notes,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.medications
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function medicationLogsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      medication_id::text AS "medicationId",
      owner_user_id::text AS "ownerUserId",
      status::text,
      dose,
      prn_reason AS "prnReason",
      scheduled_for AS "scheduledFor",
      logged_at AS "loggedAt",
      created_at AS "createdAt"
    FROM app.medication_logs
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY logged_at DESC, id
  `;
}

export function jarvisGoalsQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      owner_user_id::text AS "ownerUserId",
      title,
      desired_outcome AS "desiredOutcome",
      status::text,
      priority,
      target_at AS "targetAt",
      last_progress_summary AS "lastProgressSummary",
      blocker_summary AS "blockerSummary",
      next_suggested_action AS "nextSuggestedAction",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM app.moss_goals
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}

export function jarvisGoalEvidenceQuery(userId: string) {
  return sql<Record<string, unknown>>`
    SELECT
      id::text AS id,
      goal_id::text AS "goalId",
      owner_user_id::text AS "ownerUserId",
      evidence_kind::text AS "evidenceKind",
      source_kind::text AS "sourceKind",
      source_ref AS "sourceRef",
      source_label AS "sourceLabel",
      summary,
      occurred_at AS "occurredAt",
      created_at AS "createdAt"
    FROM app.moss_goal_evidence
    WHERE owner_user_id = ${userId}::uuid
    ORDER BY created_at, id
  `;
}
