# Source and archive outcome truth

Date: 2026-10-11
Baseline: main `58402589d9fc0f53417553139e4e3de430f26668`
Scope: the approved Moss UX audit, lane 1, CORE01/03/11.
Task: #3397 (https://github.com/motioneso/moss/issues/3397). The approved bounded umbrella implementation plan is `docs/superpowers/plans/2026-10-11-ux-audit-repairs.md` (integration owner commit `f0a11eec9`). CORE01/03 and the conservative CORE11 owned-Markdown schema/accounting contract are approved by the product owner through the integration owner.

## Verified seams

- `apps/web/src/settings/settings-personal-data-panes.tsx:344–535` owns Notes source reads, source writes, unlink confirmation and sync controls. Unlink currently toasts before the source PUT settles; an absent GET result is currently rendered as an unlinked folder.
- `apps/web/src/settings/settings-connections-pane.tsx:75–91` mounts this same source pane inside Connections.
- `apps/web/src/settings/settings-profile-subviews.tsx:90–239` restores the export job ID from tab-scoped storage, queries job status, and handles 404/expired resets. A non404 failure without cached status currently has no visible branch.
- `packages/settings/src/data-export-jobs.ts:69–180` builds the account archive and currently emits an empty `vault_files` array.
- `packages/settings/src/data-export-async-routes.ts:59–160` reads status and downloads under the actor's existing data/vault contexts.
- The approved `docs/superpowers/specs/2026-06-22-real-data-export.md:15–17,141–169` includes owned data and a `vault_files` section but does not define file eligibility or its entry representation.
- `packages/notes/src/private-note-export.ts:7,15–20,153–157` owns generated Markdown copies under `notes/generated/`. `tests/uat/seed/chunks/notes.ts:5–32` also models root and nested owned Markdown originals.
- `packages/memory/src/vault-ingest-registry.ts:13,63–75` limits ingestion to declared Markdown roots outside attachments/exports; this is an ingestion policy rather than a complete account-backup contract.
- `packages/vault/src/vault-ops.ts:213–235` lists regular files without following symlinks; byte/string reads go through the existing containment checks.

## Determinism and boundaries

All progress, success and failure feedback comes from the source mutation or export status record. There is no model call and no chat injection. Keep ownership checks, source privacy, deletion policy, grants and existing 404/expiry handling. Use existing `@moss/ui` actions and settings layouts; no new CSS or shared component contract.

Finance, Food/Meals, Job Search and Workshop remain excluded. Open issue #1694 owns downloaded-module export declarations and retained module data; this lane does not implement that work. No deletion or external-folder purge tests.

## Task 1: persisted Notes source outcome

Files: `apps/web/src/settings/settings-personal-data-panes.tsx`, `apps/web/src/settings/settings-vault-chooser.tsx`; `tests/unit/audit-source-truth.test.tsx`.

- Recheck authoritative query state at chooser/confirmation submission. Shared QueryClient mutation-cache pending authority survives pane navigation and synchronously rejects repeated queued save events before the pending render; pending chooser saves disable Use this folder, retain Cancel and show Linking. A chooser opened before a refresh fails disables save and explains Cancel-to-retry recovery.
- Cancel source queries at mutation start and again before applying the successful PUT result. An older GET resolving after persisted unlink cannot overwrite the authoritative null source.
- Unlink success feedback occurs only in the successful mutation callback.
- While the PUT is pending, retain the last known path, label the pending unlink and disable concurrent source changes and sync.
- A cold source GET renders checking or unknown failure, never “No folder linked.” Failed reads offer a local GET retry; changes stay disabled until source state is authoritative.
- A failed refresh retains the last known path with an explicit unknown-current-state message and retry.
- Regression tests must be observed red before the fix and green after: delayed/rejected unlink, cold loading/error/retry and cached source refresh failure.

Kill gate: if these changes require a different shared source API or deletion meaning, stop and return the decision to the integration owner.

## Task 2: resumed account export recovery

Files: `apps/web/src/settings/settings-profile-subviews.tsx`; `tests/unit/audit-source-truth.test.tsx`.

- A restored job with no status shows checking feedback.
- Non404 query failure displays a retryable status error and retains the same stored job ID.
- Retry invokes only the same status GET; it never starts a duplicate export.
- A failed refresh does not present cached Ready status as freshly verified.
- Existing 404 and expired reset behavior is retained. A ready record with past `expiresAt` is also expired before cleanup updates its enum. Suppress its Download, reset the stored job with expired guidance, and retire a ready link at its deadline while the pane stays open; no automatic replacement POST.
- Independent regression tests cover checking, non404 retry, cached-ready failure, and the existing 404 reset.

## Task 3: archive completeness contract

Product/security owner: the user through the integration owner. The approved repair preserves `jarvis-archive/v1` and every existing account section; it adds owned Markdown originals and explicit accounting without expanding to arbitrary files or binary backup.

Files: `packages/settings/src/data-export-jobs.ts`, `packages/settings/src/data-export-vault.ts`, `tests/unit/audit-source-vault-export.test.ts`, `tests/integration/audit-source-account-export.test.ts`, and export scope copy in the existing profile subview. The integration owner owns shared app-map/trigger changes. Existing job/status/download contracts stay unchanged; no shared public archive DTO exists in the traced source.

- Eligible files are regular lowercase `.md` files in the actor's private `VaultContext`, including root, nested and `notes/generated/` originals. Do not use the narrower ingestion registry as an export allowlist.
- Explicit non-note storage exclusions are `exports/`, `attachments/`, `workflows/` and `sports/photos/`. These are traced to the account-export worker, chat attachment service, workflow artifact producer and Sports photo store respectively. No linked external folder or other owner's folder is opened. Existing Vault listing skips symlink entries and byte reads apply the inherited containment checks. This is not a new guarantee against hostile concurrent directory replacement.
- `sections.vault_files` entries are `{path, encoding: 'base64', content, byteLength, sha256}`. Bytes are preserved exactly; paths are relative to the private vault.
- Add `manifest.vaultFiles` with `{scope: 'owned-markdown', root: 'private-vault', extension: '.md', status: 'complete' | 'partial' | 'unavailable', complete, eligibleFileCount, includedCount, excludedFiles, limitations, sizePolicy}`.
- Each regular listed file outside the eligible scope is explicitly accounted for as `{path, reason: 'not-markdown' | 'non-note-storage'}`. A failed eligible read is `{path, reason: 'read-failed'}` and makes status partial. Do not expose raw filesystem errors.
- Listing/context failure makes the note section unavailable, with `complete: false`, `eligibleFileCount: null`, zero included files and explicit limitations. A readable empty vault is complete with zero eligible/included files.
- `complete` means every eligible owned Markdown original from that listing was included; it does not mean full-account, external-file or restore completeness. Existing database records and file reads are not an atomic snapshot.
- No silent byte or file-count cap. The existing worker builds the JSON archive in memory; very large exports can exhaust worker memory and are not proven scalable by this repair.
- Permanent UI copy describes supported account records/owned Markdown and the manifest's omissions, linked external folders, attachments/other files, downloaded-module data and the absence of a supported restore flow. #1694 stays out of scope.

## Connections summary

`apps/web/src/settings/settings-connections-pane.tsx` shares the same Notes query. After a source read fails its at-a-glance folder status is Unknown, including cached linked/unlinked states. A cold pending read does not claim None. `tests/unit/audit-source-connections.test.tsx` mounts the actual query lifecycle, including cold pending, failure and same-query retry; SSR's optimistic query state is not used as a proxy for mounted failure behavior.

## Real-path acceptance

Add `tests/uat/specs/audit-source-truth.uat.spec.ts`, using the existing isolated synthetic account/notes seed and real API/worker:

1. Enter Settings → Connections and link the synthetic owned notes folder. Confirm its source through the real GET.
2. Use a real network/service interruption after bootstrap. Warm lazy Connections code through its real UI before the outage. Let the real 15-second cache freshness expire before remounting, then explicitly observe the actual source/status GET; do not infer a request from remount alone. Verify that a rejected unlink retains the source, does not announce success and can recover; a failed cached-unlinked read stays unknown. The cold no-cache branch is unit-covered and is not claimed as live proof by this spec. Never intercept or rewrite Moss responses.
3. Prepare an account export through Settings. Leave and re-enter after a real status-read interruption; confirm retry keeps its job ID and causes no additional export POST.
4. Reconnect, download through the UI and inspect the real archive against the resolved file manifest contract. Use only seeded synthetic notes.
5. Exercise keyboard actions and 390/320-pixel widths. Record bounded DOM/network assertions, not screenshots.

Integration owner adds the UAT trigger-map row. A written or mocked test is not installed live proof.

## Verification

Expected successful exit: 0, preserving each command's actual exit code.

- `pnpm exec vitest run tests/unit/audit-source-truth.test.tsx tests/unit/audit-source-vault-export.test.ts tests/unit/audit-source-connections.test.tsx`
- `pnpm exec eslint <changed-source-and-test-paths> --max-warnings=0`
- `pnpm exec prettier --check <changed-source-and-test-paths>`
- `pnpm exec tsc --noEmit` and `pnpm exec tsc -p tsconfig.tests.json --noEmit`
- Applicable aggregate static checks are the integration owner's responsibility on the assembled branch.
- All database-touching verification runs only through `.claude/skills/verify-gate/SKILL.md` and `scripts/run-gate.sh`. No direct database tests or migrations.
- Live UAT uses the repository provisioner; if Docker or dependencies cannot run, report it as not run and leave code-complete, unverified.

## Observed verification and remaining gates

- Before product repair, the source/export regression suite failed 13 assertions with the existing 404 reset passing. The Connections summary's original three cached/cold cases were also observed red against the old Linked/None/placeholder behavior.
- After repair and replacing the unrealistic cold SSR case with mounted lifecycle coverage, all 19 initial focused tests passed; three additional open-flow regressions were observed failing before the final guard repair. Expanded source/settings/chooser/private-note/meeting-account-export coverage then passed 71 tests across eight files. This proves unit behavior, not installed live behavior.
- Four owning-helper negative controls were observed failing at the intended assertions: removing non-note storage exclusions, removing Markdown eligibility, switching actor context to the other synthetic owner, and misreporting a failed read as complete. Every temporary change was restored; shared Vault internals were not modified.
- Root `tsc --noEmit` and tests `tsc -p tsconfig.tests.json --noEmit` both passed. Scoped ESLint initially identified three new-test import-type syntax problems, corrected before rerunning. Final static checks and independent review are recorded in the handoff.
- The authored integration suite exercises owner-scoped database/worker paths, real Vault bytes and actual status/download handlers with a test-only access-context resolver. It is not live authentication proof.
- `scripts/run-gate.sh start --gate test:data-export` exited 4 because Docker is unavailable. Integration and provisioned real-UI UAT remain unexecuted. No direct database workaround is permitted.
- Honest status: locally implemented, live-unverified. Independent review, assembled-branch static checks, required CI and installed real-UI proof remain merge blockers. No merge, deploy or Done transition is authorized.

## Independent review follow-up

- Review identified older-read overwrite, component-local pending authority lost during navigation, and outage UAT remounts inside the real 15-second cache freshness. Lasting source regressions were observed failing before repair. Query cancellation and shared mutation-cache authority address the two production races; real UAT waits exceed freshness and observe each actual GET. Mounted unit tests retain the application's fresh-remount behavior and verify a later stale remount makes the outage read.
- The product owner also approved bounded CORE03 ready-with-past-expiresAt and crossing-expiry-while-open repair. Both deadline regressions were observed failing before the client-side fix. The existing backend contract and archive scope are unchanged.
- Final follow-up unit/static evidence and re-review are recorded in the lane handoff. Docker still blocks integration and installed UAT proof; written request observations are not a claim those requests were observed live here.

## Release note

Category: Fixed
Title: Clear source and export outcomes
Description: Linked folders and resumed data exports now show when a change is still pending or needs retry, with accurate archive scope.
