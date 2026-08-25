// External-module admin repository helpers (#917).
//
// Extracted from repository.ts to satisfy the 1000-line file-size gate: Task 7 added the
// external-module state methods and pushed repository.ts over the cap. The public
// SettingsRepository class stays in repository.ts (a class cannot be split across files);
// only NON-class code lives here — the external-module type definitions and the DB
// row-writer / row-mapper bodies for the app.external_modules state machine. The class
// methods delegate to these functions, passing an audit-writer closure so the metadata-only
// audit write still routes through the class's private insertAuditEvent (unchanged behavior).
//
// These symbols are re-exported from ./repository.js (and thus from the package index) so the
// @moss/settings public export surface is byte-for-byte unchanged — every existing
// `import { ExternalModuleState, ... } from "@moss/settings"` / "./repository.js" resolves.
import { assertDataContextDb, type DataContextDb } from "@moss/db";

export interface SetModuleDisabledInput {
  readonly moduleId: string;
  readonly disabled: boolean;
  readonly actorUserId: string;
  readonly requestId: string;
}

// External-module admin state transitions (#917). All admin-gated at the RLS layer
// (migration 0152: INSERT/UPDATE/DELETE require app.current_actor_is_admin()).
export interface SetExternalModuleEnabledInput {
  readonly id: string;
  readonly manifestHash: string;
  readonly packageHash: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

export interface SetExternalModuleDisabledInput {
  readonly id: string;
  readonly reason: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * One persisted app.external_modules row, narrowed to what the reconcile step consumes (#917).
 * Defined locally rather than imported from @moss/module-registry to avoid a package
 * dependency cycle (module-registry already depends on @moss/settings). Structurally
 * identical to module-registry's ExternalModuleStateInput — the app-layer wiring (a later
 * task) passes these rows straight into reconcileExternalModules by structural compatibility.
 */
export interface ExternalModuleState {
  readonly id: string;
  readonly status: "enabled" | "disabled" | "draft";
  readonly packageHash: string | null;
  readonly disabledReason: string | null;
  /** #1753: NULL unless status is 'draft', in which case it is the one user this row runs for. */
  readonly ownerUserId: string | null;
}

/**
 * Audit-writer closure the class supplies so the metadata-only audit row is still written by
 * SettingsRepository.insertAuditEvent (a private method that can't be reached from here). This
 * preserves the metadata-only invariant: callers pass ONLY { moduleId } in metadata (#917).
 */
export type ExternalModuleAuditWriter = (event: {
  readonly actorUserId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
  readonly requestId: string;
}) => Promise<void>;

/**
 * All external-module enablement rows visible under RLS (#917). SELECT is granted to
 * every authed actor (instance-global state, mirrors provider_install_state), so this
 * is the read used by both the public resolver and the admin GET. Narrowed to the
 * shape reconcileExternalModules() needs (the local ExternalModuleState mirror; see its
 * doc-comment for why we don't import module-registry's type here — dependency cycle).
 */
export async function listExternalModuleStates(
  scopedDb: DataContextDb
): Promise<ExternalModuleState[]> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.external_modules")
    .select(["id", "status", "package_hash", "disabled_reason", "owner_user_id"])
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    packageHash: r.package_hash,
    disabledReason: r.disabled_reason,
    ownerUserId: r.owner_user_id
  }));
}

/**
 * Admin: enable an external module, recording the manifest + package hashes trusted at
 * this moment (#917). Upsert — enabling an already-enabled module re-captures the hash
 * (an admin re-approving a changed package). RLS INSERT/UPDATE require
 * current_actor_is_admin(); a non-admin call is rejected at the policy layer.
 */
export async function setExternalModuleEnabled(
  scopedDb: DataContextDb,
  input: SetExternalModuleEnabledInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.external_modules")
    .values({
      id: input.id,
      status: "enabled",
      manifest_hash: input.manifestHash,
      package_hash: input.packageHash,
      disabled_reason: null,
      enabled_by: input.actorUserId,
      enabled_at: new Date(),
      owner_user_id: null,
      created_at: new Date(),
      updated_at: new Date()
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        status: "enabled",
        manifest_hash: input.manifestHash,
        package_hash: input.packageHash,
        disabled_reason: null,
        // #1753: an enabled row must never carry an owner (the DB check constraint that
        // enforces this exists precisely because a leftover owner_user_id from a prior
        // draft row would be meaningless once the module is instance-wide).
        owner_user_id: null,
        enabled_by: input.actorUserId,
        enabled_at: new Date(),
        updated_at: new Date()
      })
    )
    .execute();

  // Metadata-only audit: { moduleId } ONLY, matching the module.instance_enable precedent.
  // NEVER record manifest_hash/package_hash or any content here (metadata-only invariant, #917).
  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_enable",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
}

export interface SetExternalModuleDraftInput {
  readonly id: string;
  readonly manifestHash: string;
  readonly packageHash: string;
  readonly ownerUserId: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Install a finished build as a draft (#1754), owned by the user who built it. Same upsert
 * shape as setExternalModuleEnabled, but status 'draft' with a real owner_user_id and no
 * enabled_by/enabled_at — draft rows are exempt from the live drift check and only visible to
 * their owner (see Task 6/7/8/9). RLS INSERT/UPDATE require current_actor_is_admin(), same gate
 * as an ordinary enable (Task 16 doc: owner and admin are the same person in stage 1).
 */
export async function setExternalModuleDraft(
  scopedDb: DataContextDb,
  input: SetExternalModuleDraftInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.external_modules")
    .values({
      id: input.id,
      status: "draft",
      manifest_hash: input.manifestHash,
      package_hash: input.packageHash,
      disabled_reason: null,
      enabled_by: null,
      enabled_at: null,
      owner_user_id: input.ownerUserId,
      created_at: new Date(),
      updated_at: new Date()
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        status: "draft",
        manifest_hash: input.manifestHash,
        package_hash: input.packageHash,
        disabled_reason: null,
        enabled_by: null,
        enabled_at: null,
        owner_user_id: input.ownerUserId,
        updated_at: new Date()
      })
    )
    .execute();

  // Metadata-only audit: { moduleId } ONLY, matching module.external_enable's precedent.
  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_install_draft",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
}

/**
 * Shared disable upsert + audit for both disable entry points (admin disable and drift
 * auto-disable) (#917). Upsert so a never-enabled (virtual 'discovered') module can be pinned
 * disabled too. Clears the enable pointer. `action` selects the audit action so the log
 * distinguishes "admin turned it off" from "we turned it off because the package changed".
 */
export async function writeExternalModuleDisabledRow(
  scopedDb: DataContextDb,
  input: SetExternalModuleDisabledInput,
  action: "module.external_disable" | "module.external_auto_disable",
  writeAudit: ExternalModuleAuditWriter
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.external_modules")
    .values({
      id: input.id,
      status: "disabled",
      // A disabled row still needs the NOT NULL hash columns; empty sentinels are
      // fine because activation requires status='enabled' AND a hash match — a
      // disabled row is never active regardless of what hash it carries.
      manifest_hash: "",
      package_hash: "",
      disabled_reason: input.reason,
      enabled_by: null,
      enabled_at: null,
      owner_user_id: null,
      created_at: new Date(),
      updated_at: new Date()
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        status: "disabled",
        disabled_reason: input.reason,
        enabled_by: null,
        enabled_at: null,
        updated_at: new Date()
      })
    )
    .execute();

  // Metadata-only audit: { moduleId } ONLY (metadata-only invariant, #917). The disable
  // reason IS persisted, but on the app.external_modules row (disabled_reason column) —
  // NOT in audit metadata, keeping the audit payload to the module id + actor + requestId.
  await writeAudit({
    actorUserId: input.actorUserId,
    action,
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
}

// ── #964 distribution state ─────────────────────────────────────────────────

export interface UpdateExternalModuleStagingInput {
  readonly id: string;
  readonly stagedVersion: string;
  readonly stagedPackageHash: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Record a verified admin download as staged intent (#964, spec §5 step 8). Upsert:
 * a not-yet-installed module has no row (insert, status 'disabled' — only the boot
 * reconcile flips to 'enabled' when it accepts the staged files); an update (re-download,
 * update, retry) touches ONLY the staged fields. Always 'admin-download' — the
 * compose-ensure writer is the supervisor-plane reconcile script, not this function.
 * Clears last_install_error so a retry gets a clean slate.
 */
export async function updateExternalModuleStaging(
  scopedDb: DataContextDb,
  input: UpdateExternalModuleStagingInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<void> {
  assertDataContextDb(scopedDb);
  await scopedDb.db
    .insertInto("app.external_modules")
    .values({
      id: input.id,
      status: "disabled",
      // NOT NULL hash sentinels, same rationale as writeExternalModuleDisabledRow: a
      // disabled row is never active regardless of hash; the reconcile records the real
      // hashes when it accepts the staged package.
      manifest_hash: "",
      package_hash: "",
      disabled_reason: null,
      enabled_by: null,
      enabled_at: null,
      owner_user_id: null,
      staged_version: input.stagedVersion,
      staged_package_hash: input.stagedPackageHash,
      staged_at: new Date(),
      staged_by: input.actorUserId,
      staged_source: "admin-download",
      last_install_error: null,
      created_at: new Date(),
      updated_at: new Date()
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        staged_version: input.stagedVersion,
        staged_package_hash: input.stagedPackageHash,
        staged_at: new Date(),
        staged_by: input.actorUserId,
        staged_source: "admin-download",
        last_install_error: null,
        updated_at: new Date()
      })
    )
    .execute();

  // Metadata-only audit: { moduleId } ONLY — never the hash, version, or URL (#964).
  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_stage",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
}

export interface SetExternalModulePurgeInput {
  readonly id: string;
  readonly requested: boolean;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Mark (or cancel) a data purge for the next boot reconcile (#964, spec §8). Update-only:
 * a module with no row has no recorded data to purge — returns false so the route can 404.
 * The mark is executed and cleared by the supervisor-plane reconcile, never here.
 */
export async function setExternalModulePurgeRequested(
  scopedDb: DataContextDb,
  input: SetExternalModulePurgeInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const result = await scopedDb.db
    .updateTable("app.external_modules")
    .set({
      purge_requested_at: input.requested ? new Date() : null,
      purge_requested_by: input.requested ? input.actorUserId : null,
      updated_at: new Date()
    })
    .where("id", "=", input.id)
    .executeTakeFirst();
  if ((result.numUpdatedRows ?? 0n) === 0n) return false;

  await writeAudit({
    actorUserId: input.actorUserId,
    action: input.requested ? "module.external_purge_request" : "module.external_purge_cancel",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
  return true;
}

/** Full admin-facing distribution state per row (#964). Superset of ExternalModuleState. */
export interface ExternalModuleAdminState {
  readonly id: string;
  readonly status: "enabled" | "disabled" | "draft";
  readonly packageHash: string | null;
  readonly disabledReason: string | null;
  readonly stagedVersion: string | null;
  readonly stagedPackageHash: string | null;
  readonly stagedSource: "admin-download" | "compose-ensure" | null;
  readonly purgeRequestedAt: Date | null;
  readonly lastInstallError: string | null;
  readonly ownerUserId: string | null;
}

export async function listExternalModuleAdminStates(
  scopedDb: DataContextDb
): Promise<ExternalModuleAdminState[]> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.external_modules")
    .select([
      "id",
      "status",
      "package_hash",
      "disabled_reason",
      "staged_version",
      "staged_package_hash",
      "staged_source",
      "purge_requested_at",
      "last_install_error",
      "owner_user_id"
    ])
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    packageHash: r.package_hash,
    disabledReason: r.disabled_reason,
    stagedVersion: r.staged_version,
    stagedPackageHash: r.staged_package_hash,
    stagedSource: r.staged_source,
    purgeRequestedAt: r.purge_requested_at,
    lastInstallError: r.last_install_error,
    ownerUserId: r.owner_user_id
  }));
}

export interface MarkExternalModuleRemovedInput {
  readonly id: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Admin Remove (#964 spec §9): pin the module off and clear staged intent. Data is
 * preserved (tables/ledger/KV/credentials untouched) — purge is a separate, explicit
 * flag consumed at boot. Update-only; returns false when the module has no row yet
 * (files-only remove still succeeds at the route layer). Audit is METADATA ONLY.
 */
export async function markExternalModuleRemoved(
  scopedDb: DataContextDb,
  input: MarkExternalModuleRemovedInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const result = await scopedDb.db
    .updateTable("app.external_modules")
    .set({
      status: "disabled",
      disabled_reason: "removed by admin",
      staged_version: null,
      staged_package_hash: null,
      staged_at: null,
      staged_by: null,
      staged_source: null,
      updated_at: new Date()
    })
    .where("id", "=", input.id)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) return false;
  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_remove",
    targetType: "external_module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
  return true;
}

export interface ShipExternalModuleInput {
  readonly id: string;
  /** Current on-disk hashes (from the discovery, sourced by the route the same way
   *  setExternalModuleEnabled's caller already does), captured as the new trusted drift
   *  baseline — same hash-capture an ordinary enable performs. */
  readonly manifestHash: string;
  readonly packageHash: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Shipping (#1753 Task 10): the human action that ends the draft exemption. Flips a draft to
 * enabled, clears its owner, and re-captures the current on-disk hashes so drift detection
 * (exempt while it was a draft, per reconcile.ts) resumes from this moment.
 *
 * Update-only, scoped to `status = 'draft' AND owner_user_id = actorUserId` — that WHERE
 * clause is simultaneously the "does this draft exist" and "is it yours" guard, so a caller
 * who isn't the owner gets the same `false` as a caller who names an id that was never a
 * draft (the route maps `false` to 404 — no way to distinguish the two, same non-leak
 * discipline as assertAdminUser). The route runs assertAdminUser first, so actorUserId is
 * already confirmed to be an instance admin; the ownership check on top of that is what
 * stops one admin from shipping another admin's draft.
 */
export async function shipExternalModule(
  scopedDb: DataContextDb,
  input: ShipExternalModuleInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const result = await scopedDb.db
    .updateTable("app.external_modules")
    .set({
      status: "enabled",
      manifest_hash: input.manifestHash,
      package_hash: input.packageHash,
      disabled_reason: null,
      owner_user_id: null,
      enabled_by: input.actorUserId,
      enabled_at: new Date(),
      updated_at: new Date()
    })
    .where("id", "=", input.id)
    .where("status", "=", "draft")
    .where("owner_user_id", "=", input.actorUserId)
    .executeTakeFirst();
  if ((result.numUpdatedRows ?? 0n) === 0n) return false;

  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_ship",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
  return true;
}

export interface DeleteExternalModuleDraftInput {
  readonly id: string;
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * #1890 Workshop 8: throw a draft away — the human action that ends a draft's life entirely.
 * Deliberately the mirror image of shipExternalModule: the SAME three-part predicate (this id,
 * still `draft`, owned by the caller) decides whether anything happens, so this function CANNOT
 * tell "no such module" apart from "that is a shipped module" apart from "that draft belongs to
 * another admin" — all three return false and the route turns all three into one 404. That is the
 * point: an instance admin must not be able to probe for another admin's private drafts, and
 * distinct status codes would be exactly such a probe.
 *
 * The owner and status checks live HERE, in the statement, not in a route-layer `if`. RLS on
 * app.external_modules only narrows DELETE to instance admins (0152) — which every draft author
 * already is — so the predicate is what enforces the owner-only and shipped-modules-are-safe
 * guarantees. Removing either `where` re-opens both holes silently.
 *
 * Rows only. On-disk files are the route's job, and it does them AFTER this returns true.
 */
export async function deleteExternalModuleDraft(
  scopedDb: DataContextDb,
  input: DeleteExternalModuleDraftInput,
  writeAudit: ExternalModuleAuditWriter
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const result = await scopedDb.db
    .deleteFrom("app.external_modules")
    .where("id", "=", input.id)
    .where("status", "=", "draft")
    .where("owner_user_id", "=", input.actorUserId)
    .executeTakeFirst();
  if ((result.numDeletedRows ?? 0n) === 0n) return false;

  await writeAudit({
    actorUserId: input.actorUserId,
    action: "module.external_draft_delete",
    targetType: "module",
    targetId: input.id,
    metadata: { moduleId: input.id },
    requestId: input.requestId
  });
  return true;
}
