# JS-409 local package private lifecycle

The host activates locally signed packages through the existing downloaded-package lifecycle:
staging, validation, snapshots, migrations, hooks, catalog commit and restart recovery. The
builder can upgrade and remove their package without instance-admin rights. Other accounts,
including instance admins, cannot use the account-facing catalog, navigation, screen/assets,
routes, chat tools, jobs, public APIs, events, package reads or snapshot restoration for it.
Portable module lists omit local packages.

Local manifests refuse install-wide KV, shared SQL policies, instance credentials, core lifecycle
ownership, another builder's local dependencies and shared settings. Existing archive, import
and SQL validators still run. Migration `0007_local_package_lifecycle.sql` permits only the
provenance digest to change, under the existing forced owner RLS and immutable signing identity.
Local activation metadata is sealed with the existing host cipher before entering the
admin-readable configuration catalog; the catalog and lifecycle use the same decoder.

## Installed-host proof

From `~/Jarv1s`, the exact unpiped command was:

```bash
RUSTUP_HOME=$HOME/.rustup CARGO_TARGET_DIR=/tmp/js409-target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 scripts/run-gate.sh start --gate test:rust-phase6-local-isolation
```

The launcher starts an isolated PostgreSQL gate. Its completed result was **exit 0**, not merely
a successful launch. The task proof artifact contains the completed gate receipt.

The runner removed each of 21 ownership/declaration enforcement checks separately and required
exit 101 plus the matching planted-marker assertion. It restored each source file in `finally`
and required the complete restored suite to pass. The PostgreSQL test also disabled catalog RLS,
observed rows through the foreign account and admin DataContexts, restored RLS, and observed them
hidden again. The real installed host used generated keys and exercised SQL migrations, queued
jobs, restart, upgrade, remove, reinstall and delete. A journal-boundary fault test recovered
builder data after an interrupted local upgrade.

Result: **17 isolation tests passed**, followed by **13 inherited local-trust checks passed**,
including signed invalid-SQL and undeclared-import refusals. The inherited local signing CLI
server test remains ignored in this runner; it belongs to the separate local-trust server gate.

Failing-first observations included accepted install-wide storage and shared SQL declarations,
non-owner navigation, builder removal/snapshot-listing refusals, the provenance upgrade digest
refusal, and plaintext local metadata in the admin DataContext. Each was observed red before
its implementation change. The installed queue test also caught the lifecycle reader missing
sealed local state; sharing the decoder restored queue reconciliation.

## Limits

This slice adds no management API or screens. It does not qualify private package screens in a
browser, production data, non-Unix local signing, or the later installer/release work. Its proof
is the installed host and isolated database boundary, as specified for ordered part 7/M.

## Review and remaining minor notes

The first independent review found an unkeyed catalog reader in the registry CLI and the bundle
stand-in. The reader was reproduced failing with a sealed local entry. The CLI now reads the
existing application's account projection; the bundle stand-in passes the standard host cipher
keyring to both readers and filters its account-facing output. The database test covers a keyed
catalog plus registry installation/listing/removal alongside an active local package.

The first review also recorded minor limitations below the task's must-fix threshold: error
messages can reveal existence before dispatch refuses; a declared downloaded dependency can
delay local removal; the mutation runner restores in `finally` but cannot survive SIGKILL; the
legacy ownership/signing-identity and network allowlist checks have no separate source-removal
control; and losing the host cipher key prevents catalog loading. The sealing check was observed
failing before sealing was implemented, rather than included in the automatic mutation runner.
Invalid registry inputs can report a different first validation error. Opaque-frame browser use
remains unqualified and out of this slice's screens scope. These notes are not claims of private
content being accessible to another account.
