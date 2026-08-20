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

export class AmbiguousBootstrapOwnerError extends Error {
  constructor(emails: readonly string[]) {
    super(
      "[target-identity-guard] refusing: target database has more than one bootstrap owner " +
        `(${emails.join(", ")}) — the confirmation email cannot prove which instance this is, ` +
        "and picking one of them arbitrarily would let a destructive script proceed against a " +
        "database the operator has not actually identified. Resolve the duplicate owner rows " +
        "before re-running (see #1721)."
    );
    this.name = "AmbiguousBootstrapOwnerError";
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
  // #1721: fetch two rows, not one. The old `executeTakeFirst()` had no ORDER BY, so with more
  // than one flagged row Postgres returned whichever it liked and the guard compared the
  // operator's email against an arbitrary owner. That fails in both directions: it can refuse a
  // correctly-identified target, and — worse for a guard protecting destructive operations — it
  // can accept one, because supplying either owner's email passes on the run where that row
  // happens to come back first. Ordering makes the choice repeatable; the limit-2 check makes the
  // ambiguity itself a refusal rather than a coin flip.
  const owners = await db
    .selectFrom("app.users")
    .select(["id", "email"])
    .where("is_bootstrap_owner", "=", true)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .limit(2)
    .execute();

  if (owners.length === 0) {
    throw new NoBootstrapOwnerFoundError();
  }

  if (owners.length > 1) {
    throw new AmbiguousBootstrapOwnerError(owners.map((row) => row.email));
  }

  const owner = owners[0]!;

  if (!confirmedOwnerEmail || confirmedOwnerEmail !== owner.email) {
    throw new TargetIdentityMismatchError();
  }

  return owner;
}
