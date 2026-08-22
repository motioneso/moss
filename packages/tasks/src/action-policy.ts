import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb, type PreferencesPort } from "@moss/db";
import type { MossActionPermissionTier } from "@moss/module-sdk";

export const TASK_CHANGES_POLICY_KEY = "assistant.action_policy.v1.tasks.task_changes";
export const LEGACY_AGENCY_AUTO_EXECUTE_KEY = "tasks.agency_auto_execute";

export class TasksCompatibilityHelper {
  constructor(private readonly prefs: PreferencesPort) {}

  async getResolvedTaskChangesPolicy(db: DataContextDb): Promise<MossActionPermissionTier> {
    const canonical = await this.prefs.getWithMetadata<MossActionPermissionTier>(
      db,
      TASK_CHANGES_POLICY_KEY
    );
    const legacy = await this.prefs.getWithMetadata<boolean>(db, LEGACY_AGENCY_AUTO_EXECUTE_KEY);

    if (!canonical && !legacy) return this.healInstallGrantAndReread(db);
    if (canonical && !legacy) return canonical.value;
    if (!canonical && legacy) return legacy.value ? "trusted_auto" : "ask_each_time";

    // Both exist: canonical is unconditionally authoritative. setTaskChangesPolicy always writes
    // canonical then legacy, so legacy's timestamp is essentially always >= canonical's — a
    // timestamp tie-break would silently prefer legacy's boolean, which cannot represent
    // "always_confirm" and would drop that tier back to "ask_each_time" on every read. Legacy is
    // never written independently of canonical (grepped: only setTaskChangesPolicy writes it), so
    // there is no real scenario where legacy being newer should win.
    return canonical!.value;
  }

  /**
   * #1311 tasks-side fix: the neither-row branch above must never assert "trusted_auto" — a
   * concurrent write (an explicit setTaskChangesPolicy, or another request's own install grant)
   * can land between the neither-check and this call. grantInstallTimeTrustIfUnset is a single
   * atomic NOT-EXISTS insert, so it's a no-op if a row already landed; re-reading storage after
   * it runs is what makes the return value always match what's actually stored, mirroring
   * selfHealGrantedAtInstallTier's re-read discipline
   * (packages/ai/src/gateway/self-operation.ts:495-519). Exposed (not private) so tests can
   * exercise the both-absent code path directly against a pre-seeded row.
   */
  async healInstallGrantAndReread(db: DataContextDb): Promise<MossActionPermissionTier> {
    try {
      await this.grantInstallTimeTrustIfUnset(db);
    } catch {
      return "ask_each_time";
    }
    const reread = await this.prefs.getWithMetadata<MossActionPermissionTier>(
      db,
      TASK_CHANGES_POLICY_KEY
    );
    return reread?.value ?? "ask_each_time";
  }

  async setTaskChangesPolicy(db: DataContextDb, tier: MossActionPermissionTier): Promise<void> {
    await this.prefs.upsert(db, TASK_CHANGES_POLICY_KEY, tier);
    const legacyBoolean = tier === "trusted_auto";
    await this.prefs.upsert(db, LEGACY_AGENCY_AUTO_EXECUTE_KEY, legacyBoolean);
  }

  /**
   * #1263: install-time grant for the task_changes family. Unlike the generic
   * AiRepository.insertActionPolicyIfAbsent (which only checks the canonical key), this checks
   * BOTH the canonical and legacy keys before inserting, so a user who opted out via the legacy
   * `tasks.agency_auto_execute = false` toggle before the canonical key existed does not get
   * silently flipped to trusted_auto the next time the tasks module is (re-)enabled. Single
   * atomic statement to avoid a read-then-write race between concurrent enable requests.
   */
  async grantInstallTimeTrustIfUnset(db: DataContextDb): Promise<void> {
    assertDataContextDb(db);
    await sql`
      insert into app.preferences (owner_user_id, key, value_json, updated_at)
      select app.current_actor_user_id(), ${TASK_CHANGES_POLICY_KEY},
        ${JSON.stringify("trusted_auto")}::jsonb, now()
      where not exists (
        select 1 from app.preferences
        where owner_user_id = app.current_actor_user_id()
          and key in (${TASK_CHANGES_POLICY_KEY}, ${LEGACY_AGENCY_AUTO_EXECUTE_KEY})
      )
      on conflict (owner_user_id, key) do nothing
    `.execute(db.db);
  }
}
