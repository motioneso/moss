import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { connectionStrings, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// Split out of foundation.test.ts (News Slice 1, issue #953): that file sat at the exact
// 1000-line check:file-size cap, and the migration ledger below grows with every migration.
// These are pure schema/catalog assertions (migration ledger + role/grant/policy inspection)
// that need only a pg Client against a migrated database — no DataContext, pg-boss worker,
// or probe-share seeds. Test bodies are preserved byte-for-byte from foundation.test.ts.
describe("MVP foundation schema catalog", () => {
  beforeAll(async () => {
    await resetFoundationDatabase();
  });

  it("applies versioned SQL migrations from an empty database", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });

    await client.connect();
    try {
      const migrations = await client.query<{ version: string; name: string }>(
        `
          SELECT version, name
          FROM app.schema_migrations
          ORDER BY version
        `
      );

      expect(migrations.rows).toEqual([
        { version: "0001", name: "0001_app_schema.sql" },
        { version: "0002", name: "0002_app_rls.sql" },
        { version: "0003", name: "0003_tasks_module.sql" },
        { version: "0004", name: "0004_auth_workspaces_settings.sql" },
        { version: "0005", name: "0005_admin_audit_events.sql" },
        { version: "0006", name: "0006_tasks_drop_workspace_grants.sql" },
        { version: "0008", name: "0008_notifications_module.sql" },
        { version: "0009", name: "0009_connectors_module.sql" },
        { version: "0010", name: "0010_connector_admin_safe_metadata.sql" },
        { version: "0011", name: "0011_calendar_module.sql" },
        { version: "0012", name: "0012_email_module.sql" },
        { version: "0013", name: "0013_ai_module.sql" },
        { version: "0014", name: "0014_chat_module.sql" },
        { version: "0015", name: "0015_briefings_module.sql" },
        { version: "0016", name: "0016_ai_assistant_actions.sql" },
        { version: "0017", name: "0017_shares.sql" },
        { version: "0018", name: "0018_probe_owner_or_share.sql" },
        { version: "0019", name: "0019_tasks_owner_or_share.sql" },
        { version: "0020", name: "0020_calendar_owner_or_share.sql" },
        { version: "0021", name: "0021_email_owner_or_share.sql" },
        { version: "0022", name: "0022_connectors_owner_only.sql" },
        { version: "0023", name: "0023_ai_action_requests_owner_only.sql" },
        { version: "0024", name: "0024_notifications_owner_only.sql" },
        { version: "0025", name: "0025_chat_owner_or_share.sql" },
        { version: "0026", name: "0026_briefings_owner_or_share.sql" },
        { version: "0027", name: "0027_notes_teardown.sql" },
        { version: "0028", name: "0028_workspace_teardown.sql" },
        { version: "0029", name: "0029_fix_notifications_insert_policy.sql" },
        { version: "0030", name: "0030_memory_index.sql" },
        { version: "0031", name: "0031_structured_state.sql" },
        { version: "0032", name: "0032_memory_embedding_768.sql" },
        { version: "0033", name: "0033_ai_auth_method.sql" },
        { version: "0034", name: "0034_chat_status_activity.sql" },
        { version: "0035", name: "0035_chat_messages_update_grant.sql" },
        { version: "0036", name: "0036_chat_worker_runtime_grants.sql" },
        { version: "0037", name: "0037_ai_worker_read_grants.sql" },
        { version: "0038", name: "0038_chat_live_runtime.sql" },
        { version: "0039", name: "0039_tasks_foundation.sql" },
        { version: "0040", name: "0040_memory_chat_source.sql" },
        { version: "0041", name: "0041_memory_facts.sql" },
        { version: "0042", name: "0042_chat_memory_settings.sql" },
        { version: "0043", name: "0043_connector_google_enum.sql" },
        { version: "0044", name: "0044_google_unified_connection.sql" },
        { version: "0045", name: "0045_auth_secret_rls.sql" },
        { version: "0046", name: "0046_auth_sessions_rls.sql" },
        { version: "0047", name: "0047_users_rls_tighten.sql" },
        { version: "0048", name: "0048_ai_model_tier.sql" },
        { version: "0049", name: "0049_chat_conversation_summary.sql" },
        { version: "0050", name: "0050_multi_user_accounts.sql" },
        { version: "0051", name: "0051_fix_current_actor_user_id_grant.sql" },
        { version: "0052", name: "0052_fix_admin_select_policy.sql" },
        { version: "0053", name: "0053_users_guard_admin_flag.sql" },
        { version: "0054", name: "0054_worker_memory_rls.sql" },
        { version: "0055", name: "0055_users_guard_admin_flag_v2.sql" },
        { version: "0056", name: "0056_drop_dead_workspace_subsystem.sql" },
        { version: "0057", name: "0057_revoke_app_runtime_chat_update.sql" },
        { version: "0058", name: "0058_chat_threads_incognito_immutable.sql" },
        { version: "0059", name: "0059_admin_tables_rls.sql" },
        { version: "0060", name: "0060_chat_memory_settings_to_role.sql" },
        { version: "0061", name: "0061_memory_facts_to_role.sql" },
        { version: "0062", name: "0062_task_tag_assignments_ownership.sql" },
        { version: "0063", name: "0063_tasks_fk_indexes.sql" },
        { version: "0064", name: "0064_chat_memory_facts_source_thread_idx.sql" },
        { version: "0065", name: "0065_module_enablement.sql" },
        { version: "0066", name: "0066_calendar_worker_grants_and_google_insert.sql" },
        { version: "0067", name: "0067_email_summary_signals_columns.sql" },
        { version: "0068", name: "0068_email_worker_grants_and_google_insert.sql" },
        { version: "0069", name: "0069_connector_worker_runtime_grants.sql" },
        { version: "0070", name: "0070_commitments_worker_grant.sql" },
        { version: "0071", name: "0071_notifications_worker_insert_grant.sql" },
        { version: "0075", name: "0075_tasks_worker_recurrence_grant.sql" },
        { version: "0079", name: "0079_member_onboarding.sql" },
        { version: "0082", name: "0082_wellness_checkins.sql" },
        { version: "0083", name: "0083_wellness_medications.sql" },
        { version: "0084", name: "0084_wellness_medication_logs.sql" },
        { version: "0085", name: "0085_briefing_runs_owner_only_select.sql" },
        {
          version: "0086",
          name: "0086_module_enablement_instance_select_actor_guard.sql"
        },
        {
          version: "0087",
          name: "0087_calendar_events_update_connector_scope.sql"
        },
        { version: "0088", name: "0088_wellness_emotion_taxonomy.sql" },
        { version: "0089", name: "0089_wellness_therapy_notes.sql" },
        { version: "0090", name: "0090_chat_memory_facts_provenance.sql" },
        { version: "0091", name: "0091_chat_model_override.sql" },
        { version: "0092", name: "0092_inferred_patterns_suppression.sql" },
        { version: "0093", name: "0093_preferences_worker_runtime_grants.sql" },
        { version: "0094", name: "0094_chat_memory_facts_rls_roles.sql" },
        { version: "0095", name: "0095_bootstrap_audit_security_definer.sql" },
        { version: "0096", name: "0096_chat_memory_corrections_log.sql" },
        { version: "0097", name: "0097_chat_memory_corrections_update_grant.sql" },
        { version: "0098", name: "0098_ai_cancel_stale_assistant_actions.sql" },
        { version: "0099", name: "0099_connector_health_metadata.sql" },
        {
          version: "0100",
          name: "0100_connector_admin_safe_metadata_health.sql"
        },
        {
          version: "0101",
          name: "0101_notifications_metadata_size_check.sql"
        },
        {
          version: "0102",
          name: "0102_notifications_defense_in_depth_comments.sql"
        },
        {
          version: "0103",
          name: "0103_provider_install_state.sql"
        },
        {
          version: "0104",
          name: "0104_wellness_medication_logs_prn_reason_optional.sql"
        },
        {
          version: "0105",
          name: "0105_notifications_urgency_deferral.sql"
        },
        {
          version: "0106",
          name: "0106_memory_notes_source_kind.sql"
        },
        {
          version: "0107",
          name: "0107_wellness_checkins_temporal.sql"
        },
        {
          version: "0108",
          name: "0108_data_export_jobs.sql"
        },
        {
          version: "0109",
          name: "0109_instance_settings_delete_grant.sql"
        },
        {
          version: "0110",
          name: "0110_memory_links_worker_write.sql"
        },
        {
          version: "0111",
          name: "0111_preferences_worker_write.sql"
        },
        {
          version: "0112",
          name: "0112_data_export_cleanup_function.sql"
        },
        {
          version: "0113",
          name: "0113_worker_calendar_events_delete.sql"
        },
        {
          version: "0114",
          name: "0114_data_export_jobs_format_and_params.sql"
        },
        {
          version: "0115",
          name: "0115_list_expired_data_export_jobs_format.sql"
        },
        {
          version: "0116",
          name: "0116_briefing_type.sql"
        },
        {
          version: "0117",
          name: "0117_provider_execution_mode.sql"
        },
        {
          version: "0118",
          name: "0118_memory_graph_substrate.sql"
        },
        {
          version: "0119",
          name: "0119_memory_candidates.sql"
        },
        {
          version: "0120",
          name: "0120_usefulness_feedback_signals.sql"
        },
        {
          version: "0121",
          name: "0121_confidence_aware_memory_records.sql"
        },
        {
          version: "0122",
          name: "0122_proactive_monitoring.sql"
        },
        { version: "0123", name: "0123_long_running_goals.sql" },
        { version: "0124", name: "0124_scheduled_recurring_briefings.sql" },
        { version: "0125", name: "0125_commitment_candidates.sql" },
        { version: "0126", name: "0126_app_runtime_calendar_events_delete.sql" },
        { version: "0127", name: "0127_jarvis_action_audit_log.sql" },
        { version: "0128", name: "0128_person_context.sql" },
        { version: "0129", name: "0129_yolo_action_audit_mode.sql" },
        { version: "0130", name: "0130_connector_imap_enum.sql" },
        { version: "0131", name: "0131_connector_imap_definitions.sql" },
        { version: "0132", name: "0132_email_imap_insert.sql" },
        { version: "0133", name: "0133_sports_follows.sql" },
        { version: "0134", name: "0134_data_export_jobs_worker_select_grant.sql" },
        { version: "0135", name: "0135_wellness_worker_read_grants.sql" },
        { version: "0136", name: "0136_admin_audit_events_worker_insert.sql" },
        { version: "0137", name: "0137_data_export_jobs_worker_bounded_functions.sql" },
        { version: "0138", name: "0138_worker_get_data_export_job.sql" },
        { version: "0139", name: "0139_wellness_worker_read_policies.sql" },
        { version: "0140", name: "0140_task_status_suggested.sql" },
        { version: "0141", name: "0141_email_triage_feedback.sql" },
        { version: "0142", name: "0142_notifications_module_id.sql" },
        { version: "0143", name: "0143_wellness_checkins_local_date_backfill.sql" },
        { version: "0144", name: "0144_google_sync_sweep_accounts.sql" },
        { version: "0145", name: "0145_jarvis_error_log.sql" },
        // Merge-up (#876): reconciles #744 (chat 0146) with #870 Slice-1 (ai 0147/0148).
        // Global migration order is strictly numeric across modules, so 0146→0147→0148→0149.
        { version: "0146", name: "0146_private_chat_cleanup.sql" },
        // #870/H1 — instance-default provider flag.
        { version: "0147", name: "0147_ai_provider_instance_default.sql" },
        // #870 Fable HIGH-1 — worker INSERT grant/policy for jarvis_error_log (H3 observability).
        { version: "0148", name: "0148_jarvis_error_log_worker_insert.sql" },
        // #760 Task 1 — personal chat_skills library table, owner-only RLS. Renumbered
        // 0147->0149 during rebase to resolve collision with merged #870 (0147/0148).
        { version: "0149", name: "0149_chat_skills.sql" },
        // #874 — `purpose` discriminator + one-voice partial unique index for the Voice(STT)
        // endpoint. Renumbered 0149->0150: chat's 0149_chat_skills (#889) landed on main
        // first, and migrations are global by landing order, so this takes the next free slot.
        { version: "0150", name: "0150_ai_provider_purpose.sql" },
        // #897 — news module prefs (sources / excludes / topics), owner-only RLS.
        { version: "0151", name: "0151_news_prefs.sql" },
        // #917 (epic #860) — external module enablement state; instance-global, admin-managed.
        { version: "0152", name: "0152_external_modules.sql" },
        // #918 (epic #860) — module credential secrets; FORCE RLS, no app_runtime DELETE.
        { version: "0153", name: "0153_module_credentials.sql" },
        // #918 (epic #860) — module KV storage; FORCE RLS, scope-shaped policies.
        { version: "0154", name: "0154_module_kv.sql" },
        // #914 Slice 1 — per-module applied-migration ledger, instance bookkeeping.
        { version: "0155", name: "0155_module_schema_migrations.sql" },
        // #914 Slice 2 — per-module install-state journal, instance metadata.
        { version: "0156", name: "0156_module_installs.sql" },
        // #919 (epic #860) — actor + module scoped worker RPC access for credentials/KV.
        { version: "0157", name: "0157_module_worker_runtime_access.sql" },
        { version: "0158", name: "0158_external_module_active_users.sql" },
        // #953 (epic #954) News Slice 1 — personalization tables (custom sources/topics,
        // domain exclusions, compilation snapshot); owner-only FORCE RLS, no worker grants.
        { version: "0159", name: "0159_news_personalization.sql" },
        { version: "0160", name: "0160_news_discovery.sql" },
        // #975 (epic #954) News Slice 4 — column-scoped worker UPDATE grants so the
        // revalidation worker can persist validation outcomes; RLS keeps writes owner-scoped.
        { version: "0161", name: "0161_news_revalidation.sql" },
        // #964 module distribution — staged-download intent, purge marks, last install error.
        { version: "0162", name: "0162_external_module_distribution.sql" },
        // #982/#869 D6 — admin-only hard reconcile of CLI concrete model rows.
        { version: "0163", name: "0163_ai_cli_model_reconcile_delete.sql" },
        // #985 — bounded key-name metadata for native-YOLO audit rows.
        { version: "0164", name: "0164_action_audit_input_summary.sql" },
        // #1059 — owner-terminal step-up password (scrypt hash only), admin-only FORCE RLS.
        { version: "0165", name: "0165_ai_terminal_password.sql" },
        // #1077 export worker grants — 4 confirmed export-gap tables get worker_runtime
        // SELECT-only + exact-mirror worker SELECT policy (no narrowing/widening, no writes).
        { version: "0166", name: "0166_worker_notification_reads_grant.sql" },
        { version: "0167", name: "0167_worker_entities_grant.sql" },
        { version: "0168", name: "0168_worker_action_requests_grant.sql" },
        { version: "0169", name: "0169_worker_audit_log_grant.sql" },
        // #1077 follow-up — 0166 must never be edited post-apply, so the COMMENT ON POLICY
        // it dropped (via DROP POLICY/CREATE POLICY) is restated in its own migration.
        { version: "0170", name: "0170_notification_reads_worker_policy_comment.sql" },
        // FIN-00 #1145 — worker-written user-scope credentials (auth.setCredential RPC):
        // INSERT+UPDATE grants for jarvis_worker_runtime, RLS owner+module-bound, user scope only.
        { version: "0171", name: "0171_module_credentials_worker_write.sql" },
        // #1238/#1239 — default execution_mode flips 'interactive' → 'non_interactive'
        // (one-shot engine default for all providers); interactive stays a per-provider fallback.
        { version: "0172", name: "0172_default_execution_mode_non_interactive.sql" },
        // #1238/#1239 — re-run 0172's backfill under a DISABLE/ENABLE+FORCE toggle: 0172's
        // UPDATE hit 0 rows because the migration owner is NOBYPASSRLS on this FORCE-RLS table.
        { version: "0173", name: "0173_backfill_execution_mode_under_force_rls.sql" },
        // JS-00 #1231 — surface-scoped live chat thread lineage and cleanup identity.
        // Renumbered 0172→0174 on integration: P-02a (#1239) landed 0172/0173 first.
        { version: "0174", name: "0174_chat_surface.sql" },
        // #1264 — optimistic-concurrency revision column for assistant self-operation writes.
        { version: "0175", name: "0175_preferences_revision.sql" },
        // #1264 — forward infra: same CAS revision column on core-owned app.instance_settings,
        // no consumer yet.
        { version: "0176", name: "0176_instance_settings_revision.sql" },
        // #1264 — widen audit outcome CHECK for settings CAS-conflict/validation-error tools.
        { version: "0177", name: "0177_audit_outcome_widen.sql" },
        { version: "0178", name: "0178_task_suggestion_metadata.sql" },
        { version: "0179", name: "0179_email_action_suppression.sql" },
        { version: "0180", name: "0180_email_action_suppression_evidence.sql" },
        // Task 2b #1283 — ctx.notify keyed upsert: event_key/href/updated_at columns, the
        // partial unique index that makes a re-fired key update its row in place, and the
        // UPDATE-on-notifications + DELETE-on-notification_reads grant/policy pairs (both
        // runtime roles) the keyed upsert and its return-to-unread clear actually need.
        // Never applied under either earlier branch-local number.
        { version: "0181", name: "0181_notification_event_keys.sql" },
        // #1444 — the app.jarvis_* -> app.moss_* table rename, split by owning module. Every
        // renamed object belongs to the goals or ai module, so both files live in those modules'
        // own sql/ directories: scripts/migrate.ts drains the core directory before any module
        // directory, so a core migration would run before 0123/0127/0145 had created the tables
        // and abort 42P01 on a fresh database. Versions stay globally unique.
        { version: "0182", name: "0182_moss_rename_goals.sql" },
        { version: "0183", name: "0183_moss_rename_ai.sql" },
        // #1383 — narrow audit-insert grant for the sanctioned admin-reset-password CLI.
        { version: "0184", name: "0184_admin_reset_password_audit_insert.sql" }
      ]);
    } finally {
      await client.end();
    }
  });

  it("exposes only the narrow bootstrap audit SECURITY DEFINER helper to app runtime", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const result = await client.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        app_can_execute: boolean;
      }>(`
        SELECT p.proname,
               p.prosecdef,
               pg_get_userbyid(p.proowner) AS owner,
               has_function_privilege(
                 'jarvis_app_runtime',
                 p.oid,
                 'EXECUTE'
               ) AS app_can_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname = 'record_bootstrap_owner_audit_event'
      `);

      expect(result.rows).toEqual([
        {
          proname: "record_bootstrap_owner_audit_event",
          prosecdef: true,
          owner: "jarvis_migration_owner",
          app_can_execute: true
        }
      ]);
    } finally {
      await client.end();
    }
  });

  it("keeps runtime roles from owning protected tables or bypassing RLS", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });

    await client.connect();
    try {
      const roles = await client.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `
          SELECT rolname, rolsuper, rolbypassrls
          FROM pg_roles
          WHERE rolname IN ('jarvis_app_runtime', 'jarvis_worker_runtime')
          ORDER BY rolname
        `
      );

      const owner = await client.query<{ tableowner: string }>(
        `
          SELECT tableowner
          FROM pg_tables
          WHERE schemaname = 'app'
            AND tablename = 'rls_probe_items'
        `
      );

      expect(roles.rows).toEqual([
        { rolname: "jarvis_app_runtime", rolsuper: false, rolbypassrls: false },
        { rolname: "jarvis_worker_runtime", rolsuper: false, rolbypassrls: false }
      ]);
      expect(owner.rows[0]?.tableowner).toBe("jarvis_migration_owner");
    } finally {
      await client.end();
    }
  });

  it("confirms workspace/grant tables are absent after DROP migration", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const result = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'app'
           AND table_name IN ('workspaces','workspace_memberships','resource_grants')`
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("pgboss narrowed grants (#174)", () => {
  beforeAll(async () => {
    await resetFoundationDatabase();
  });

  it("jarvis_app_runtime cannot UPDATE pgboss.job after narrowing", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ has_privilege: boolean }>(
        `SELECT has_table_privilege('jarvis_app_runtime', 'pgboss.job', 'update') AS has_privilege`
      );
      expect(result.rows[0]?.has_privilege).toBe(false);
    } finally {
      await client.end();
    }
  });

  it("jarvis_worker_runtime can UPDATE pgboss.job after narrowing", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ has_privilege: boolean }>(
        `SELECT has_table_privilege('jarvis_worker_runtime', 'pgboss.job', 'update') AS has_privilege`
      );
      expect(result.rows[0]?.has_privilege).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("jarvis_app_runtime can SELECT pgboss.queue (required for boss.send)", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ has_privilege: boolean }>(
        `SELECT has_table_privilege('jarvis_app_runtime', 'pgboss.queue', 'select') AS has_privilege`
      );
      expect(result.rows[0]?.has_privilege).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("jarvis_app_runtime cannot DELETE from pgboss.job", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ has_privilege: boolean }>(
        `SELECT has_table_privilege('jarvis_app_runtime', 'pgboss.job', 'delete') AS has_privilege`
      );
      expect(result.rows[0]?.has_privilege).toBe(false);
    } finally {
      await client.end();
    }
  });
});

describe("chat_messages UPDATE grant revoked + policy narrowed (#134)", () => {
  beforeAll(async () => {
    await resetFoundationDatabase();
  });

  it("jarvis_app_runtime cannot UPDATE app.chat_messages after migration", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ has_privilege: boolean }>(
        `SELECT has_table_privilege('jarvis_app_runtime', 'app.chat_messages', 'update') AS has_privilege`
      );
      expect(result.rows[0]?.has_privilege).toBe(false);
    } finally {
      await client.end();
    }
  });

  it("chat_messages_update policy targets only jarvis_worker_runtime and keeps owner scoping", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{
        roles: string[];
        qual: string | null;
        with_check: string | null;
      }>(
        `SELECT roles, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'app'
            AND tablename = 'chat_messages'
            AND policyname = 'chat_messages_update'`
      );
      const policy = result.rows[0];
      expect(policy).toBeDefined();
      expect(policy?.roles).toContain("jarvis_worker_runtime");
      expect(policy?.roles).not.toContain("jarvis_app_runtime");
      // Postgres may print qualified form (app.current_actor_user_id) or unqualified.
      // The invariant: predicate is owner-scoped, NOT simply `true`.
      expect(policy?.qual).toContain("owner_user_id");
      expect(policy?.qual).toContain("current_actor_user_id()");
      expect(policy?.with_check).toContain("owner_user_id");
      expect(policy?.with_check).toContain("current_actor_user_id()");
    } finally {
      await client.end();
    }
  });
});
