# #3138 standalone checkpoint

Status: code-complete, unverified. This checkpoint must not merge on source review
or focused unit checks alone. The actual isolated database gate and installed real
UI/worker proof remain required on the composed final integration head.

## Delivered implementation

The exact owned Tasks read supports the existing saved interval/daily/weekly
cadence. First valid observation is a quiet baseline; later title/status changes
produce one sourced normal chat message. Unchanged observations skip the report
model and message persistence, but record quiet success. Failed/refused runs are
honest history; per-run transient retries remain capped at two. A consecutive
exhausted-run streak posts guidance once at three and resets after valid success.

Execution status is separate from active/paused lifecycle. Quiet/failure history
and no-message final occurrence completion share the existing responsibility
lock, immutable occurrence version, saved cadence and result identity. The
existing 20 active/paused reminder/check limit and 60-second minimum remain;
briefings retain independent ownership. Source content and model output cannot
add cadence, source operations, recipients or permission fields. Unsupported
recurrence/start/stop terms fail closed rather than becoming a one-time check.

New SQL is `packages/chat/sql/0321_chat_repeating_reads.sql`, assigned after the
reserved 0320 destination migration. No applied migration is edited. Manifest and
foundation migration inventory include 0321.

## Verification so far

Inputs: intentional integration base `8c4b1aff5`, committed plan `790219ce`, then
the standalone implementation files recorded in this checkpoint's diff. No
result from this baseline certifies a later integration tip.

- Initial observation/request checks failed on the unimplemented feature, then
  passed. Additional unsupported cadence, erased start and source-title-created
  cadence checks were observed failing before their fixes and passing afterward.
- Removing exact cadence equality made its authority-negative assertion fail;
  restoring it made the same test pass. SQL authority-removal checks are written
  but not observed because database execution is unavailable in this executor.
- Final unified 22-file bundle: 256 tests passed, including real-gateway
  boundary, context, Settings, app-map, manifest and worker-composition units.
  These are focused units, not the full foundation gate or actual queue/database
  proof.
- Scoped ESLint and Prettier, app-map build, migration collision, file-size,
  design-token and UI-class checks passed. The collision check had no base-branch
  migration claims, so cross-PR ordering is coordinator-owned.
- First root compiler attempt exhausted its default 2GB heap. The 4GB run found
  two fixture literal-type errors, corrected to `retryable: true as const`.
  The later worker-mock required-data finding is corrected with `data: {}`.
  Final serialized root, tests, web and all three external-module TypeScript
  stages passed with a 4GB heap, covering the complete typecheck contract.
- `scripts/run-gate.sh start --gate test:integration:3138` failed at environment
  admission, exit 4: Docker is absent. No database migration or test ran here.
- Screenshot-free installed UAT is prepared at
  `tests/uat/specs/3138-repeating-useful-checks-real.uat.spec.ts`; it was not run
  here. It uses real UI Tasks changes, Settings/chat, one update, quiet history,
  controlled isolated-worker downtime and viewport/theme DOM assertions.

Fresh source review found no remaining identified standalone code blocker after
fixes. This is not a database or live-path approval. Required positive/negative
DB cases are in `tests/integration/3138-repeating-scheduled-read.test.ts` and the
`test:integration:3138` script. Existing one-time-read guard assertions were
updated only where #3138 intentionally adds recurrence.

## Mandatory 0320 -> 0321 composition before readiness

PR #3500 adds destination-edit and target-loss behavior. Standalone 0321 replaces
`app.enforce_chat_reminder_update` from the old Main-only baseline and cannot
simply follow 0320 unchanged. On rebase after #3500 lands:

1. Compose both update-trigger bodies. Preserve authorized destination changes,
   `app.check_chat_reminder_destination` validation and destination_title
   immutability; add recurring read advancement and no-message terminal rules.
2. Preserve the destination `FOR SHARE` recheck in the read runner, replacing
   this standalone Main-only guard. Destination access/loss wins before commit.
3. Preserve immutable occurrence-message thread identity in run history,
   notification retrieval and pending context. Then broaden message-bearing
   outcome predicates to delivered/failed/refused. Quiet/expired have no message.
4. Broaden #3500's acknowledgeMain outcome predicate as well; otherwise a posted
   failed/refused result remains unacknowledged. Keep actor and destination guards.
5. Keep all destination DTO/type fields and both 0320/0321 manifest/catalog entries.
6. Replace destination suite's obsolete one-time-read mutation assertion and
   adapt its advancement mutation matcher to the composed trigger.
7. Repeat independent source review and full isolated gate against final bytes.
   Observe SQL authority negatives failing with protection removed, then restore.
8. Run actual installed final-head UI/worker proof, including a recurring read
   moved after earlier results, destination loss during a run, and failed/refused
   message context/notification after moving. Never rewrite responses or use
   screenshots as live proof. No merge until the actual checks pass.

The coordinator owns publication and final-head verification/merge. This lane
has not published GitHub changes, merged, deployed or accessed a server.
