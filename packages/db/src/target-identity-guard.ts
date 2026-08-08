import type { Kysely } from "kysely";

import type { MossDatabase } from "./types.js";

export class NoBootstrapOwnerFoundError extends Error {
  constructor() {
    super(
      "[target-identity-guard] refusing: target database has no bootstrap owner row — cannot " +
        "prove operator identity against a target whose owner can't be identified"
    );
    this.name = "NoBootstrapOwnerFoundError";
  }
}

export class TargetIdentityMismatchError extends Error {
  constructor() {
    super(
      "[target-identity-guard] refusing: confirmation email does not match the target " +
        "database's actual bootstrap owner"
    );
    this.name = "TargetIdentityMismatchError";
  }
}

/**
 * #1383: proves an operator script is pointed at the instance it thinks it is before a
 * credential-mutating or destructive operation proceeds, by requiring the caller to supply
 * the TARGET's own actual bootstrap-owner email back. Identity is proven against the thing
 * being modified, not against a hardcoded or env-configured fingerprint — that shape fails
 * open the moment the fingerprint is unset, stale, or there is more than one production
 * instance (Moss is self-hosted; `setup-prod.ts` supports N>1 real deployments). Modeled on
 * #1082's `assertTargetIsEphemeral` (tests/uat/seed/guard.ts), which inspects the target's
 * actual contents rather than trusting a caller-supplied flag.
 *
 * No bootstrap owner found is also a failure, not a pass-through: a script that can't
 * identify what it's connected to has no basis to proceed either.
 *
 * Returns the confirmed owner row so callers that need it (e.g. to scope a follow-up
 * write to that user's id) don't have to re-query and risk a TOCTOU gap between the
 * two lookups.
 */
export async function assertOperatorConfirmsTargetOwner(
  db: Kysely<MossDatabase>,
  confirmedOwnerEmail: string | undefined
): Promise<{ readonly id: string; readonly email: string }> {
  const owner = await db
    .selectFrom("app.users")
    .select(["id", "email"])
    .where("is_bootstrap_owner", "=", true)
    .executeTakeFirst();

  if (!owner) {
    throw new NoBootstrapOwnerFoundError();
  }

  if (!confirmedOwnerEmail || confirmedOwnerEmail !== owner.email) {
    throw new TargetIdentityMismatchError();
  }

  return owner;
}
