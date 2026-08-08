# Admin Password Recovery Runbook

Covers recovering a locked-out bootstrap owner's login when there is no other active admin
to reset it through the app. `scripts/admin-reset-password.ts` (`pnpm admin:reset-password`)
is the **only sanctioned way** to do this outside the app's own auth flows.

See also: issue #1383 — the incident that motivated this script and the target-identity guard
it's built on.

---

## Why this exists

A prior incident (#1383) locked out the bootstrap owner's prod login: a scratch script wrote
`app.auth_accounts` directly, using `@moss/auth`'s `hashPassword` plus a raw DB write, with the
shell's `JARVIS_PGHOST`/`JARVIS_PGPORT` pointed at prod instead of dev. The script had no way to
know it was aimed at the wrong instance, so it "worked" — against the wrong database.

Two changes close this off:

- **`packages/db/src/urls.ts`** now refuses to build a default-credentialed connection string
  (`postgres:postgres@...`) whenever `JARVIS_PGHOST`/`JARVIS_PGPORT` differ from the local dev
  defaults (`localhost:55433`), in any `NODE_ENV`. An explicit `*_DATABASE_URL` is required to
  point anywhere else. A default-credentialed URL silently built against a non-default host is
  exactly what let #1383's script reach prod without an explicit choice to do so.
- **`packages/db/src/target-identity-guard.ts`**'s `assertOperatorConfirmsTargetOwner` requires
  the operator to name the target database's own actual bootstrap-owner email before any
  credential-mutating write proceeds. Identity is proven against the thing being modified, not
  against an env flag or hardcoded fingerprint — a fingerprint can be stale or simply wrong,
  which is exactly how #1383 happened. `scripts/delete-user-data-cli.ts --execute` uses the same
  guard, for the same reason.

**What this does not cover:** both protections apply to scripts that go through
`getMossDatabaseUrls()`/the guard. Direct writes with a raw `psql`/`pg` client on the bootstrap
superuser role bypass Postgres RLS unconditionally (`FORCE ROW LEVEL SECURITY` does not apply to
a superuser) and are outside what any RLS policy or grant can constrain. Don't write ad-hoc
credential-reset scripts — use this one.

---

## Prerequisites

- You know the target instance's bootstrap owner email (the account being reset). The script
  queries the target database for its `is_bootstrap_owner = true` row and refuses to proceed
  unless the email you supply matches what it finds — this is the check, not a formality.
- Correct environment variables for the target instance: either `JARVIS_MIGRATION_DATABASE_URL`
  set explicitly, or `JARVIS_PGHOST`/`JARVIS_PGPORT` pointed at it (local dev defaults are used
  if neither is set).

---

## Procedure

```bash
pnpm admin:reset-password -- --execute
```

Run with no other flags and the script prompts interactively for the owner's email and the new
password — this is the safest way to run it, since it avoids the new password or an operator
typo landing in shell history. Both can also be passed as flags for scripted/non-interactive use:

```bash
pnpm admin:reset-password -- --execute \
  --confirm-owner-email owner@example.com \
  --password "a new password, at least 8 characters"
```

On success the script prints the confirmed owner's email/id and the audit event id it recorded,
and never logs the password or its hash. On mismatch it throws `TargetIdentityMismatchError`
(wrong email, or you're pointed at a different instance than you think) or
`NoBootstrapOwnerFoundError` (the target database has no identifiable owner — proceeding would
have no basis to confirm identity against).

Every run writes an `app.admin_audit_events` row (`action: 'admin_password_reset'`) so a
password reset is always visible in the instance's own audit trail.

---

## If the script itself fails to connect

Check `JARVIS_MIGRATION_DATABASE_URL` (or `JARVIS_PGHOST`/`JARVIS_PGPORT`) point at the intended
instance. If you're intentionally targeting a non-default host/port, `getMossDatabaseUrls()`
now requires every connection URL used (bootstrap/migration/app/auth/worker) to be set
explicitly — see `packages/db/src/urls.ts`. This is deliberate: it's the fix for #1383.
