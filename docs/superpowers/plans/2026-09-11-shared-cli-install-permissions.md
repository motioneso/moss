# Shared CLI installer permissions — implementation plan

Status: approved by Ben on 2026-09-11. This plan implements automatic startup repair with no Install/Reinstall UI, and nothing beyond that correction.

Spec: `docs/superpowers/specs/2026-09-11-shared-cli-install-permissions.md`.
Inspected baseline: merged main `2fcf428ae9dfd7317bc61c10c4859b61b47172a3`, still current on 2026-09-11.
Draft location: `~/Jarv1s/.claude/worktrees/build-prod-cli-recovery`.

## Approved behavior and existing startup path

The original Settings-installer assumption has been removed from the approved spec. Existing onboarding installation and Settings login remain unchanged. Removing and re-adding a provider changes configuration only; it is not the repair mechanism.

`CliChatEngineHost.startupSweep` already calls `InstallService.reconcileInstalledProviders` after release cleanup and before accepting requests (`packages/cli-runner/src/engine-host.ts:894`). Reconciliation uses the ordinary installer for already-installed providers. A launcher-owned 0700 release is executable by the launcher, so the current presence check at `install-service.ts:701` reaches it; isolated users cannot traverse it. The fix belongs in shared npm publication and its no-op validation, with tests through the existing startup entry point. Do not add another startup service or alter installed-provider discovery unless the required real-identity regression demonstrates that this affected release is skipped.

Fresh npm service instances have no pinned hash and already reinstall through the existing path. Healthy no-op preservation therefore applies when the existing version/hash requirements are satisfied, not to every runner restart. The plan does not add persisted hashes or change version policy.

## Scope and ownership

One PR, one Builder at a time, one product implementation task covering publication, automatic existing-release recovery, tests and app-map wording. Documentation preparation and live proof are ordered separately below; no batch review. Builder pushes each source task, Reviewer reviews the settled head, Builder corrects that task, and PM confirms before the next starts. Prover owns live acceptance and never fixes code.

Two users means two Moss accounts running the same installed Codex CLI. No Install/Reinstall UI, normal-user login surface, provider configuration per user, Anthropic/Google authentication changes, model-list migration, new installer endpoint, background repair service, dependency, or production deployment is included. Registry onboarding, latest-version checks, scheduled updates and YOLO-mode self-modification remain separate. Existing shared npm callers receive the generic publication correction; provider recipes and versions are unchanged.

## Task 1 — commit the approved documents

After Ben approves this plan, Builder records approval in its status and commits only this plan and the approved spec. Create the one task issue and one PR through the normal project workflow, or reuse the PM-designated issue if it exists. The PR targets current merged main; PM resolves branch ownership before Builder starts. Do not add implementation to the already-merged PR 2456.

Use one assigned worktree throughout execution. These files are currently uncommitted drafts in the former recovery worktree; transfer their exact approved contents into the assigned checkout without losing or overwriting other work. Do not reset, rebase or repurpose another agent's active checkout. Recheck the baseline if main has advanced; report a substantive conflict to PM before changing the approved approach.

This task has one documentation commit. Run Prettier on both documents, inspect their complete diff for public-repository suitability, and run `git diff --check`. No private hostnames, account details, credentials or machine-specific absolute paths belong in them. Push, wait for the PR checks, then Reviewer confirms the committed documents match the approved copies and PM confirms Task 1. No product implementation starts before that confirmation.

## Task 2 — publication, recovery, regression checks and app map

One implementation commit, amended for review corrections. Expected production files are `packages/cli-runner/src/install-service.ts` and `packages/shared/src/app-map-core.ts`. Test files are `tests/unit/cli-runner-install.test.ts` and one new executable `scripts/check-cli-install-permissions.ts`. Do not extract a new generic framework or enlarge the existing Codex login diagnostic. If verification finds another required production change, report the exact blocker to PM before expanding scope.

### Production change

1. In the shared npm publication path, set the verified release directory to mode 0755 before renaming it into the published release and switching `current`. While still under `.staging`, the enclosing directory must remain 0700 so users cannot traverse unpublished contents. A permission-setting failure must return the existing installation error outcome before `current` changes. Keep installer ownership; do not recursively chmod dependencies, credential homes or the tools volume. This fixes every caller of `promoteNpm`, not a Codex-only branch.
2. In the npm branch of `tryIdempotentNoop`, require the currently published release root to be an actual directory with the intended 0755 permissions before accepting the existing version/hash checks as a no-op. Use the existing release resolver and `lstat` so a symlink at the release-root location is not accepted as that directory. A missing or nonconforming release must return to normal staged installation, not chmod an arbitrary live symlink target or report `alreadyInstalled`. Preserve other I/O failures as installation errors where appropriate. Keep artifact-recipe behavior unchanged.
3. Recovery deliberately uses a normal reinstall through `reconcileInstalledProviders`: a legacy 0700 release, including one with an in-memory pinned hash, must be replaced with a new correctly published release. A healthy matching install retains the existing no-op behavior and `binaryChanged:false`; a replacement returns `binaryChanged:true` through the existing install contract. Reconciliation itself returns void, so tests must inspect the real installation result and filesystem, not invent a startup success response. Preserve version/hash verification, provider locking, symlink layout, never-installed-provider behavior and per-provider startup failure isolation.
4. In `CORE_APP_SETTINGS`, update the existing `aiproviders` description with this meaning: shared CLI software is usable by separate Moss accounts, and runner startup automatically repairs the older installation-directory permission defect using the pinned version; users need no reinstall action. Retain the administrator-only, same-account Codex sign-in limitation. Do not claim software installation signs users in, creates per-user provider configuration, fetches the latest release or repairs arbitrary host permission errors. Include a Fixed release note describing automatic recovery from the shared CLI permission defect.

### Small executable regression

Write the focused unit cases under a `shared release permissions` describe block and build the new diagnostic before changing the installer. Run the focused cases and the diagnostic against baseline code: fresh/replacement publication and legacy recovery must expose the defect, and actual execution as an isolated account must fail even when installation reports success. Record each failure and its assertion; a diagnostic that stops at its first fresh-install failure does not by itself prove the legacy test is connected. Apply the implementation only after recording red, then run the same checks successfully. Commit the tests and implementation together, not as a separate red task.

Reuse the existing `scripts/check-codex-login-isolation.ts` container/identity pattern and the npm fixture shape from `tests/unit/cli-runner-install.test.ts`; leave those production-identity checks intact. Use real `InstallService.installProvider`, real filesystem promotion and real executable children. Only npm delivery is synthetic. Other I/O commands, especially executable probes, must run or be explicitly simulated only where they are not the acceptance assertion. Do not return a fabricated success for either user's executable run.

- Refuse invocation outside the expected disposable container. Root creates temporary fixtures and starts launcher UID/GID1000 with only CHOWN/SETUID/SETGID; root does not run the installer under test. Two actual isolated runtimes use different owner UIDs/GIDs, empty supplementary groups, and zero permitted/effective/inheritable/ambient capabilities. Assert those identities from `/proc`, including the launcher's allowed capability set. Use the existing isolated runtime/privilege-drop functions rather than hand-copying their security logic.
- Use a launcher-owned tools fixture with passable, non-writable-by-users parents, including `bin`, provider and releases directories. Keep `.staging` private. Give both account homes separate synthetic credentials with 0700 directories and 0600 files. Credential checks execute under their owners; the launcher must not gain permission to read owner files. This proves these fixture properties, not safety of arbitrary pre-existing host directory permissions.
- After fresh installation, execute the stable CLI path as both owners and assert its version/output and successful exit. Reinstall through a new service instance to exercise actual replacement, then prove both owners again and verify the release target changed. This is distinct from a healthy same-instance no-op.
- Reproduce legacy permissions by setting only the disposable current release root to 0700. Call `reconcileInstalledProviders` on the same service with its pinned hash still present; require actual reinstall, not `alreadyInstalled`, and execution by both owners. Prepare the restrictive fixture again and repeat through a fresh service's `startupSweep` followed by `reconcileInstalledProviders`, in production order. Verify the target changes and both users execute the result. Then verify a healthy same-instance reconciliation is a no-op with unchanged release target. Also retain one direct installer legacy case to prove existing callers receive the same correction.
- As both owners, attempt writes to the installed executable and attempts to unlink/replace its release entry, `current` and stable binary link; require denial. Check each account's synthetic credential contents, ownership and modes before/after installation through owner commands, and deny cross-account reads. Do not print fixture contents as evidence.
- During the fake npm delivery callback, before publication, have both owners attempt access to staging and require denial. Also test an injected failure in the new permission-setting operation before publication while a prior working release exists: the installer returns error, the old target/bytes remain unchanged, and both owners still execute it. Use a test-only filesystem fault injection for this unit case; no production injection API.
- Provide three explicit negative fixture modes: `--negative-shared-write`, `--negative-credential-read`, `--negative-staging-access`. Each removes only the named protection in disposable state and must fail the same protected assertion with a nonzero top-level exit. Exercise all named write targets and both user identities before producing an aggregate failure, so the first expected failure does not conceal disconnected assertions. Record each denial assertion becoming a failure when access is deliberately granted. Restore protected behavior by rerunning in a new container. These modes are not successful wrappers around hidden child failures.

Extend the existing unit installer suite with fresh/replacement mode checks; legacy same-hash direct-install and startup recovery; fresh-process startup recovery; release-root symlink/missing/nonconforming checks; and permission-setting failure before publication. Reuse its fake npm fixture and the existing startup tests at lines 568 onward. Keep healthy same-instance no-op and never-installed cases. Add a startup failure-isolation case with two installed providers: the first real installation fails, its result is not installed and its prior target remains selected, while the next provider is still reconciled. Do not stub the method whose repair behavior is being asserted. These unit probes do not replace actual-UID execution in the diagnostic. Existing route tests remain regression checks for administrator authorization and unchanged response handling. Do not enable the network-gated Anthropic installer test for this Codex acceptance.

### Exact local checks

Run from the assigned PR worktree. First resolve a locally available immutable Moss image; do not pull an image or mount live data for the synthetic diagnostic. The image must provide the existing Node/tsx/setpriv runtime. If unavailable, report that blocker to PM rather than claiming the real-identity check passed.

Run these newly added focused cases before production edits and again after the fix, recording the red and green outputs:

```sh
env JARVIS_LIVE_INSTALL_TEST=0 pnpm vitest run tests/unit/cli-runner-install.test.ts -t 'shared release permissions'
```

```sh
docker image inspect ghcr.io/motioneso/moss:edge --format '{{.Id}}'
```

Set `INSTALL_CHECK_IMAGE` to that exact reported `sha256:...` value and record it. Define this wrapper; it returns Docker's exit unchanged:

```sh
run_install_permissions_check() {
  docker run --rm --user 0:0 --network none --cap-drop ALL \
    --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
    --cap-add FOWNER --cap-add KILL \
    --security-opt no-new-privileges:true \
    --mount "type=bind,src=$PWD,dst=/app,readonly" --workdir /app \
    "$INSTALL_CHECK_IMAGE" node --import tsx \
    scripts/check-cli-install-permissions.ts "$@"
}
```

Run each invocation separately and record its actual exit, without a pipeline masking failures. The first protected invocation is also the command used for the baseline red run before implementation. The three negative invocations must exit nonzero with their named assertion failures; the final protected run must exit zero.

```sh
run_install_permissions_check
run_install_permissions_check --negative-shared-write
run_install_permissions_check --negative-credential-read
run_install_permissions_check --negative-staging-access
run_install_permissions_check
```

Then run:

```sh
env JARVIS_LIVE_INSTALL_TEST=0 pnpm vitest run tests/unit/cli-runner-install.test.ts tests/unit/onboarding-provider-install-route.test.ts tests/unit/onboarding-provider-login-route.test.ts tests/unit/provider-install-state.test.ts tests/unit/app-map-build.test.ts tests/unit/app-map-contract.test.ts
pnpm lint
pnpm format:check
pnpm check:file-size
pnpm typecheck
pnpm build:app-map
git diff --check
```

The named route suites use fake DB dependencies. The existing real-network Anthropic install test is intentionally skipped and must be reported as skipped, not passed. Do not run `pnpm verify:foundation` or any DB-touching test without the required verify-gate skill and its isolated target. If unavailable, report the local foundation gate as not run; GitHub checks remain separately required.

After push, record the PR number as `INSTALL_PR` and capture:

```sh
git rev-parse HEAD
gh pr view "$INSTALL_PR" --json url,headRefOid,baseRefName
gh pr checks "$INSTALL_PR"
git status --short
```

Report check names and conclusions for that exact head. A pending, skipped or failed check is not a success. Reviewer independently reviews Task 2 and verifies its relevant evidence; PM confirms only after corrections and settled checks. Prover starts Task 3 only on that confirmed head.

## Task 3 — live dev proof and closeout

This is a proof task, not another source commit. Prover receives the exact reviewed head, approved dev target and two already-provisioned accounts from PM. No production access or new normal-user sign-in flow is authorized. Existing installation API authorization remains administrator-only; recovery is exercised by ordinary runner startup.

Before the run, record the previous dev image/revision, deployment configuration, exact tools-volume identity, and non-secret credential ownership/modes. Preserve the prior dev tools volume and configuration for rollback. Use a separately named disposable tools volume with the deployment's normal launcher ownership and no group/other write access; do not reuse the historical manually repaired or world-writable proof volume. If the deployment itself creates unsafe shared parents, report that precise prerequisite failure to PM; do not silently chmod it during acceptance or broaden this code task. Credentials stay in their existing owner homes and are not re-provisioned by this task.

Use bounded executable UI assertions and textual evidence, not screenshots. The proof uses normal runner startup and then the actual chat UI:

1. With the dedicated runner stopped, prepare a separately named disposable copy of the dev tools state with the launcher-owned current Codex release root at 0700. Confirm it is accessible to the launcher but inaccessible to both isolated accounts; record the existing release target and pinned version. This is deliberate defect setup, never a manual repair. Keep fixture setup separate from acceptance evidence and avoid copying credentials into the shared tools state.
2. Start the corrected runner through its normal deployment entry point. Allow startup cleanup/reconciliation to run before accepting chat. Assert that the affected release was actually replaced, the resulting release root is 0755 with unchanged installer ownership, and the stable binary works for both users. Capture old/new targets and the existing install/startup evidence; do not add a response field merely for proof. No Settings action, direct installation API call, chmod, chown or manual symlink repair may make the fixture usable after startup begins. Run both real UI chats as described below.
3. Restart that recovered dev runner normally, then repeat both-user executable and fresh-chat checks. Record whether the target changed; a fresh npm service may legitimately reinstall because it has no pinned hash. Do not claim that every healthy restart must be a no-op. Confirm readiness and credential ownership/modes remain unchanged.

Fresh installation and other replacement/error scenarios are proven by the executable regression in Task 2. This live gate proves automatic recovery of an affected real Codex release and continued two-user use after restart, as required by the corrected spec. It contains no nonexistent Settings installer interaction.

After recovery in step 2 and the restart in step 3, run the ordinary stable `codex --version` path as both isolated identities with the actual runner runtime and collect kernel UID/GID/group/capability evidence. Then open a fresh real chat session as each Moss account, send a unique bounded marker, and assert response displayed, user and assistant messages persisted, and retained after reload. Record actual provider/model, completion timing, installed head and readiness. A cached provider process is insufficient: demonstrate a new session/process after publication. Use a 60-second chat observation deadline; a timeout is a failed proof, followed by the normal cancel path and an explicit report of whether cancellation and session release were confirmed.

Administrator installation authorization is covered by the unchanged route regression tests; live acceptance makes no direct installer request. Assert credential ownership/modes are unchanged. Do not log credential contents, session tokens or broad environment dumps. Existing device authentication is a setup prerequisite, not acceptance of normal-user recovery. Attach the live run artifact, commands, exits and bounded UI/network/log assertions to the PR. Missing credentials, failed startup recovery, failed chats or unproven behavior block completion and go to PM.

### Rollback

- Installation failure: the prior working release must remain usable. The pre-publication permission failure regression explicitly verifies this; retain existing integrity checks and rollback behavior. Do not manually point a failed acceptance run at a different release and call it passed.
- Dev proof failure: record the failure first, then restore only the named prior dev tools volume and recorded deployment configuration/image. Restart only the dedicated dev services, check readiness, and preserve the failed disposable volume and evidence for diagnosis. No live credential permissions or ownership are changed to recover the run. Never delete a broad path or overwrite the original tools volume.
- Code regression: Builder corrects the same task and returns to Reviewer; a changed head invalidates old-head live acceptance. Post-merge rollback, if needed, is a separately authorized revert PR through the ordinary checks. This plan does not authorize production rollback or deployment.

PM confirms final acceptance only when the PR contains the exact-head GitHub conclusions, Reviewer verdict and Prover's live artifact. Until live proof passes, status remains code-complete, unverified. Merge authority remains with PM under Ben's room process, never Builder or Reviewer.

## Boundary report and limits

Every task report includes the five numbered boundary items, exact commands/exits, negative assertion output and unrun checks:

1. Stream serialization: N/A, installer changes emit no chat subscriber records.
2. Masking corpus: N/A while existing redactors remain unchanged; report the separate filesystem security negative results above. Changing a masker makes the room's shared-corpus/red-first gate applicable and requires PM scope review.
3. Notification pass-through: N/A, no notification mapping changes.
4. Single record writer: N/A, no record writer changes.
5. Creation order: N/A, no buffering or sequence changes.

This document prescribes future work. Its tests, negative modes, live scenarios and rollback have not been executed. Source and existing test paths were read from merged main; graph discovery was followed by bounded committed-file reads where the graph omitted tests. No product code or deployment changed while drafting this plan.
