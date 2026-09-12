# Saved day-plan storage

R2.2-T01 introduces a Calendar-owned repository and browser-safe shared contract
for #2453. This is an internal storage boundary; it adds no route, screen, provider
executor or user-visible app-map capability.

Call the repository inside `DataContextRunner.withDataContext`. Draft saves require
the revision returned by the latest read. Missing or invalid revisions return 400;
stale revisions return 409. A rejected transaction rolls back both the revision and
block changes. Task lookup uses the injected public Tasks repository.

Draft blocks accept pending additions, moves and removals. They reject the
`actualPlacement` property, including null. Updating an existing block leaves its
stored actual placement untouched. Omitting blocks retains them. A supplied list
may omit unplaced draft blocks, including clearing them with an empty list, but
omitting any block with recorded placement rejects the whole save with 400.
Keep that block and propose a pending removal until application succeeds.
Canonical task status and dates remain unchanged.

Evening-intent patches preserve omitted fields, clear nullable fields with null,
clear lists with an empty list, and reset the full intent with a null patch. Reads
retain nullable source-run references. Block kinds remain `focus`, `meeting`,
`prep`, `break`, `personal` and `unscheduled`. Proposed timestamps use UTC ISO
instants with seconds and optional three-digit milliseconds; invalid dates and
rollover times are rejected.

Operation reservation locks the plan while checking its current revision. Reusing
an idempotency key requires the same kind, revision, operation key and block ID.
Both new and reused keys fail when their expected revision is stale. Reservation
records intent only; execution belongs to a later task.

## C2 additive migration correction

Applied files 0229 and 0230 remain unchanged. The existing runner orders text
versions by filename, so 0229a preserves original columns before 0230 on a future
upgrade. It renames them with a `legacy_0229_` prefix and supplies replacement
columns for 0230. Renames preserve every owner's values without a row-security
filtered copy. If 0230 already ran, preservation is skipped; missing history is
never reconstructed.

Migration 0231 restores supported notes, capacity and placement from preserved
columns. Free-text priority, unsupported values and ambiguous pending changes stay
in the owner-scoped legacy columns. Proposals never become actual placement, and
no provider reference or verified commitment is fabricated. Existing 0230 intent,
placement and operation rows remain unchanged. Reconciliation uses the existing
transactional migration-owner procedure and restores forced row security before
commit.

Migration 0232 repairs blank legacy notes copied by 0231 without changing any of
the earlier migration files. Unchanged blank notes become typed null, using the
same whitespace definition as repository validation. Raw legacy notes and later
typed edits remain intact; forced row security is restored before commit.

Operations reference a block and its plan together. A foreign block, including one
in another plan belonging to the same actor, cannot satisfy that constraint.
Deleting a block clears only its reference and retains the operation's plan.

The focused migration cases cover fresh installation, populated 0229 upgrade,
populated 0230 upgrade, blank-note repository round trips after applied 0231,
and repeated execution. They run with the existing runner
and actual migration role in protected disposable databases, with no concurrent
application writes. Shared databases must not be reset or used for these checks.
Data discarded before preservation was installed remains historically unproven;
these migrations do not recover it.

The single task evidence record is the body of PR #2464, tied to its exact head.
The focused database assertions must run on a protected isolated target; their
presence in source is not acceptance proof. Review and independent Prover
acceptance remain required before merge.
