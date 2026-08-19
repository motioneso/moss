# Plan — #1002 Coming-soon Commitment Inventory

- Spec: `docs/superpowers/specs/2026-07-15-1002-coming-soon-inventory.md`
- Status: Proposed; no GitHub or product mutation before UX Coordinator approval
- Grounded on: `origin/main` `514e9b78`

## Scope and sequencing

This execution reconciles trackers and honest UI only. It does not build any promised capability.
The coordinator owns GitHub mutations. Tasks 2–5 share one contract test and therefore run serially
in one isolated build-agent worktree; do not parallelize them. Stage only the files named by each
task.

### Mechanical risk tiers

These tiers describe execution mechanics, not the future capabilities' product/security risk:

| Tier | Mechanical meaning                                                             | Required control                                                                         |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| M1   | Read-only verification or isolated presentation change with no shared contract | Focused check; stage named paths only                                                    |
| M2   | Multi-surface UI, destructive-flow copy, or reversible GitHub mutation         | Serial task ownership, focused tests, and live surface verification                      |
| M3   | Shared exported UI contract or hot-file collision                              | Hard collision gate, fresh rebase/regrounding, full typecheck, then full repository gate |

| Task | Tier | Why                                                                                   |
| ---- | ---- | ------------------------------------------------------------------------------------- |
| 1    | M2   | Creates/reopens live trackers and establishes numbers consumed by code                |
| 2    | M3   | Changes exported `Row`/`ComingSoon` contracts in a file also touched by open PR #1050 |
| 3    | M2   | Updates two settings surfaces and depends on Task 1's live issue numbers              |
| 4    | M2   | Changes onboarding provider choices and their browser coverage                        |
| 5    | M2   | Changes safety copy inside the destructive account-deletion flow                      |
| 6    | M1   | Read-only integration and automated verification                                      |
| 7    | M2   | Live export/delete-flow verification; deletion must be cancelled                      |
| 8    | M2   | Mutates the live #1002 inventory after evidence is green                              |

### Live collision gate: PR #1050

PR #1050 (`ux/991-assistant-priorities-build`) is open and edits
`packages/settings-ui/src/index.tsx`, the shared hot file in Task 2. Do not start Task 2 or resolve
that overlap by hand while #1050 is active. The coordinator must choose one of these gates:

1. Wait for #1050 to merge, then create/rebase the #1002 build branch on the new `origin/main`,
   re-read the merged `Row`/`ComingSoon` source, and rerun the Task 2 failing test before editing.
2. If #1050 closes unmerged, fetch current `origin/main`, confirm the file no longer has an active
   owner, and reground Task 2 before editing.

Tasks 2–5 remain serial after this gate. Do not cherry-pick, overwrite, or independently reconcile
#1050's settings-ui change.

## Task 1 — Establish concrete tracker ownership (M2, coordinator, no code)

GitHub changes after plan approval:

1. Create **Admin operations — safe instance-wide data export** from the spec's tracker contract;
   record its issue number as `<INSTANCE_EXPORT_ISSUE>`.
2. Create **Admin operations — backup status and point-in-time restore**, referencing closed #56 and
   #70; record its number as `<BACKUP_RESTORE_ISSUE>`.
3. Reopen #743, add parent #1002 and its explicit scheduling state, and refresh acceptance criteria
   to the spec contract. Keep #827 as the deferred umbrella, not the delivery owner.
4. Verify #1061 is still open and unchanged as the GitHub integration owner.

Checks:

```bash
gh issue view <INSTANCE_EXPORT_ISSUE> --json state,title,body,url
gh issue view <BACKUP_RESTORE_ISSUE> --json state,title,body,url
gh issue view 743 --json state,title,body,url
gh issue view 1061 --json state,title,body,url
```

Gate: all four issues are open and have concrete scope plus acceptance criteria before UI code is
committed. Do not move board items or close issues.

## Task 2 — Make shared settings promises require a tracker (M3, TDD)

Files:

- Modify `packages/settings-ui/src/index.tsx`
- Delete `apps/web/src/shell/coming-soon.tsx`
- Create `tests/unit/coming-soon-inventory.test.ts`

Steps:

1. Write the contract test to fail on boolean `coming`, a `ComingSoon` call without an issue, and the
   dead shell helper. Direct-marker scanning is added after the known onboarding debt is removed in
   Task 4.
2. Change `ComingSoon` to require `{ issue: number }` and render `Coming soon · #<issue>`.
3. Replace `Row`'s `coming?: boolean` with `comingIssue?: number` and pass it to `ComingSoon`.
4. Delete the unreferenced shell helper.
5. Run:

```bash
pnpm exec vitest run tests/unit/coming-soon-inventory.test.ts
pnpm typecheck
```

Expected: green. Commit only these three paths with a user-facing note that future labels now name
their delivery issue.

## Task 3 — Map Audit and Push promises (M2, TDD, after Task 2)

Files:

- Modify `apps/web/src/settings/settings-audit-pane.tsx`
- Modify `apps/web/src/settings/settings-module-subviews.tsx`
- Extend `tests/unit/coming-soon-inventory.test.ts`

Steps:

1. Add failing assertions for the exact mappings.
2. Replace the Audit rows with:
   - Export instance data's numeric `comingIssue` set to `<INSTANCE_EXPORT_ISSUE>`.
   - Backup & restore's numeric `comingIssue` set to `<BACKUP_RESTORE_ISSUE>`.
3. Replace the Notifications Push row with `comingIssue={743}` and remove the redundant tracker
   sentence from its description.
4. Run the focused test and `pnpm typecheck`; commit only these files.

## Task 4 — Remove only explicitly unplanned onboarding promises (M2, TDD, after Task 3)

Files:

- Modify `apps/web/src/onboarding/google-connector-step.tsx`
- Modify `tests/e2e/onboarding.spec.ts`
- Extend `tests/unit/coming-soon-inventory.test.ts`

Steps:

1. Change the existing Playwright expectation so the provider picker still shows Google plus every
   working `IMAP_PROVIDERS` entry, but not Outlook, Microsoft 365, or a standalone `Soon` marker.
2. Remove `SOON_PROVIDERS` and its rendering branch. Remove imports made unused by that deletion.
3. Change “Connect another account or preview upcoming services” to truthful working-flow copy.
4. Extend the contract test to scan rendered TSX for direct `Coming soon` or standalone `Soon`
   markers without a nearby `#<number>`. Exempt the shared tracked primitive, not individual product
   surfaces.
5. Run:

```bash
pnpm exec vitest run tests/unit/coming-soon-inventory.test.ts
pnpm exec playwright test tests/e2e/onboarding.spec.ts
pnpm typecheck
```

Expected: green. Commit only these three paths with a user-facing note that onboarding now lists
services that can actually connect.

## Task 5 — Point deletion at the shipped export flow (M2, TDD, after Task 4)

Files:

- Modify `apps/web/src/settings/delete-account.tsx`
- Modify `tests/unit/settings-personal-panes.test.tsx`

Steps:

1. Add a failing assertion that the Profile pane renders Data export before Danger zone and does
   not say export is unavailable.
2. Replace the dialog note with `Export your data above before deleting your account.` Keep
   `DataExport` and all destructive confirmation logic unchanged.
3. Run:

```bash
pnpm exec vitest run tests/unit/settings-personal-panes.test.tsx tests/unit/coming-soon-inventory.test.ts
pnpm typecheck
```

Expected: green. Commit only these two paths with a user-facing note that people are directed to
the existing export before deletion.

## Task 6 — Integrate and verify all current promise surfaces (M1)

After Tasks 2–5 are integrated, verify the unchanged GitHub promise in
`apps/web/src/settings/settings-personal-data-panes.tsx` still renders `Coming soon · #1061` and is
non-actionable. Do not edit it unless the focused test exposes drift.

Run automated gates:

```bash
pnpm exec vitest run tests/unit/coming-soon-inventory.test.ts tests/unit/settings-personal-panes.test.tsx
pnpm exec playwright test tests/e2e/onboarding.spec.ts tests/e2e/connect-google.spec.ts tests/e2e/connect-imap.spec.ts
pnpm verify:foundation
pnpm audit:release-hardening
```

All commands must exit 0.

## Task 7 — Required live UI verification (M2)

Use a provisioned UAT instance with an admin user. Verify at both desktop (at least 1280 px) and
narrow (390 px) widths, using keyboard navigation as well as pointer input:

1. **Audit & operations:** Export instance data shows `#<INSTANCE_EXPORT_ISSUE>`; Backup & restore
   shows `#<BACKUP_RESTORE_ISSUE>`; neither looks actionable.
2. **Notifications:** Push shows `#743`; in-app and email-digest controls still work as before.
3. **Connected accounts:** GitHub shows `#1061`, is disabled/non-actionable, and Google/Email (IMAP)
   remain actionable.
4. **Onboarding provider picker:** Google and working IMAP providers remain; Outlook, Microsoft 365,
   “Soon”, and “preview upcoming services” are absent.
5. **Profile:** create and download a personal export through the real Data export control; then open
   Delete account and confirm the note points to that control. Cancel without deleting the user.

Record pass/fail, viewport, and DOM assertions for all five surfaces. Evidence must contain no credentials,
tokens, export contents, or typed destructive-confirmation values.

## Task 8 — Update the live #1002 inventory (M2, coordinator)

After automated and live UI verification are green:

- Update #1002's inventory with the final two new issue numbers, reopened #743, and #1061.
- Record Outlook/Microsoft 365 as removed because live GitHub declares them out of product.
- Record the delete-dialog export statement as resolved by the shipped personal export flow.
- Record Apple/Other as already reconciled by #995 and note that #1003 remains independent.
- Leave #1002 open for review/merge; do not move the board, close issues, or merge.

## Final PR evidence

The implementation PR must list:

- final promise → tracker mappings;
- exact automated commands and exit codes;
- live UI matrix results;
- release-note summary: `Future capability labels now name their delivery issue, onboarding no
longer advertises unplanned Microsoft connectors, and account deletion points to the working data
export.`

Do not broaden the PR into any promised capability's implementation.
