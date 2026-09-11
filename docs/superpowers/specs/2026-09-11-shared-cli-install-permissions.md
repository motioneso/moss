# Shared CLI installs usable by isolated accounts

Status: approved by Ben in the ACP Work room on 2026-09-11, including the amendment to automatic startup repair with no Install/Reinstall UI. Approval covers separate Moss accounts using the same installed CLI; it adds no separate provider configuration per user. The implementation plan requires separate approval before implementation and remains provisional until aligned with this amendment.

Baseline: merged main `2fcf428ae9dfd7317bc61c10c4859b61b47172a3`, confirmed current on 2026-09-11. Repository: `~/Jarv1s`.

Approved planning correction: the original spec incorrectly assumed Settings had an installation/reinstallation control. The installer client in `apps/web/src/api/onboarding-connect-client.ts:29` is called by onboarding's `cli-auth-step.tsx:207`; Settings exposes login and terminal actions instead. Removing a provider revokes its saved configuration, and adding one creates configuration and discovers models; neither action installs or repairs the CLI (`packages/ai/src/repository.ts:488`, `packages/ai/src/routes.ts:186`). This amendment removes the proposed Install/Reinstall action and uses the runner's existing startup reconciliation (`packages/cli-runner/src/install-service.ts:693`) to recover affected installations automatically. Ben's preferred future flow is automatic software readiness when adding a provider, with regular updates; adding that behavior and determining update/version policy are separate follow-up work, not part of this correction.

## Problem and intended result

The existing installer can report Codex installed successfully while the account that runs Codex cannot execute the installed CLI. The shared npm installer creates a private temporary directory and promotes that same directory into the published release without changing its permissions. Its own verification runs as the installer, so it does not detect that isolated accounts cannot traverse the release.

Merged source: `packages/cli-runner/src/install-service.ts:757` creates staging with `mkdtemp`; line 463 renames it into the release; line 426 verifies execution as the installer. Node creates the temporary directory with mode 0700. Renaming preserves that mode. Codex's catalog entry uses this npm installation path.

The production deployment report recorded a 0700 release, an isolated Codex login failing with permission denied, and successful login after a manual permission adjustment to that release. This is reported live evidence corroborating the source finding, not a new reproduction performed for this spec. The manual repair does not correct future installations.

After this correction, a successful installation or reinstallation publishes a CLI that two distinct isolated accounts can execute through its ordinary stable binary path. On startup, the corrected runner automatically detects and replaces an affected existing installation using the current pinned recipe. No user install/reinstall action or operator permission repair is required. Shared executable access does not grant either account permission to modify the installation or another account's credentials.

## Scope and behavior

This is one bounded installer correction on one PR. It covers the existing shared npm release publication path used by Codex. The generic correction applies to callers of that same path; it adds no provider support or provider-specific authentication behavior.

- Fresh installation and actual reinstallation must both produce a usable release for isolated accounts.
- An existing affected 0700 release must be detected and replaced through the existing runner startup reconciliation and ordinary installer. An already-installed/no-op result must not report success while leaving that release inaccessible, including in a process that already holds a matching pinned hash. Startup must not skip the affected release as though it were never installed. Never-installed providers retain their existing installation trigger; startup does not install every catalog entry.
- Recovery uses the current pinned recipe and existing integrity checks, not the latest upstream release. Preserve the existing startup failure isolation: one provider's failed repair must not stop unrelated providers or be reported as a successful repair. No new repair endpoint, scheduled updater or background migration is required.
- Publication must not expose a new current release before its execution permissions are ready. Existing version pinning, integrity verification, atomic switching and failure handling remain required. A failed replacement must not damage the prior usable installation.
- The installer retains ownership. Isolated accounts may read/traverse the public executable tree as needed to run it, but may not write binaries, replace release contents, or replace the stable/current links through writable parent directories. No new group/other write access is permitted.
- Unpublished staging remains private to the installer. Permission changes must be confined to the shared installation path; no recursive permission change across data or credential volumes.
- Account homes and credential files retain their existing owner identity and owner-only permissions. The correction neither reads nor copies credentials and grants no additional process privileges.
- No Install/Reinstall UI is added. Existing onboarding installation, Settings login and administrator authorization remain in place; removing and re-adding a provider remains configuration-only. Any changed installer requirement, error or automatic-startup remediation must be accurately reflected in the owning app-map declarations in the same PR.

These are acceptance requirements, not claims that the new behavior has already been proven.

## Explicit exclusions

Normal-user self-service login, administrator impersonation of another account, and changes to the existing login authorization gates are excluded. The approved `docs/superpowers/plans/2026-09-10-codex-login-corrections.md` deliberately retains administrator-only Settings login. An ordinary account with credentials provisioned through an approved test setup can chat; this does not prove it can obtain or recover credentials through the product.

Anthropic/Google credential storage, login flows, rejection caches, model discovery and live provider acceptance are excluded. Their shared authentication behavior is not migrated. Artifact-based installer redesign, provider/model routing, cancellation/timeouts, unattended callers, bridge deletion and Workshop work are excluded. This spec does not authorize production changes or creating a second production account.

Automatic installation on Settings provider addition, latest-version lookup, scheduled CLI updates, update cadence, ACP adapter compatibility research and external-agent onboarding are follow-up work. ACP communication does not itself install or update the locally launched software. This correction preserves existing version pinning and adds no provider or external-agent support.

## Acceptance evidence

### Executable regression

Use the actual installer and publication flow with synthetic package contents in disposable storage. Mock package delivery where needed, but do not mock away filesystem permissions, release publication or execution as the account identities under test. No real credentials or vendor request is needed for this check.

1. Run the installer under the production-equivalent launcher identity and capability limits. Execute the resulting stable binary path as two different allocated user identities, with empty supplementary groups and zero permitted, effective, inheritable and ambient capabilities. Both executions must succeed and report the expected synthetic version. Checking mode bits or executing only as the installer is insufficient.
2. Cover fresh installation, actual replacement installation, and automatic recovery of an existing inaccessible release through the real startup reconciliation entry point. Cover a matching version/hash with bad permissions in the already-installed branch as well as a fresh runner process. Verify both users after each case. Also verify that startup leaves never-installed providers untouched and retains healthy-install no-op behavior when its existing version/hash requirements are satisfied.
3. Observe the execution regression fail against the existing 0700 publication behavior, then pass with the correction. Record exact commands, exit codes and the failing assertion on the PR.
4. As each isolated identity, attempts to modify the installed executable or replace its release/current/stable link must fail. Use synthetic owner-only credential fixtures to verify that installation does not change their ownership or modes and that the other identity cannot read them. Observe these security assertions fail when the corresponding protection is deliberately removed in disposable fixtures; restore protection and rerun successfully. Never weaken a live installation or use actual credentials for negative checks.
5. Exercise a failed replacement and confirm the prior usable binary remains selected and executable. Exercise a startup repair failure and confirm it is not reported as repaired and does not prevent reconciliation of other installed providers. Confirm unpromoted staging stays inaccessible to the isolated identities. Retain relevant existing installer checks; broader unrelated test expansion is outside this task.

### Live dev proof

Prover records the installed commit and uses a dedicated dev instance with two existing, separately authenticated Moss accounts: one administrator and one ordinary user. Both must have separately provisioned valid Codex credentials from an approved setup. Missing credentials are reported as blockers, not bypassed by widening access.

On disposable dev tools state, prepare an affected 0700 release before starting the corrected runner, then exercise the ordinary runner startup. Record that reconciliation detected and actually replaced the affected release before proving chat; an untouched previously repaired release does not prove the fix. Fixture preparation may deliberately reproduce the restrictive mode, but no manual chmod, chown, direct installer API call or container-level repair may make the published release usable during acceptance. Restart with the recovered state and verify it remains usable. Fresh installation and other replacement cases are covered by the executable regression above; this live proof specifically exercises automatic startup recovery and requires no Settings installation control.

After automatic recovery and the subsequent restart, prove the ordinary stable Codex executable runs as both isolated identities and open a fresh chat session for each account through the real UI. Each chat must complete, display its response, and persist both user and assistant messages; reload must retain them. Record provider/model and request timing. A previously running process or cached conversation is not proof of execution from the newly published release. Confirm dev readiness and unchanged credential ownership/modes without exposing credential contents.

Use bounded DOM/network/log assertions, not screenshots. Attach the run artifact, commands, exits and assertions to the PR. This proves installed CLI availability and already-provisioned account chat, not normal-user sign-in or production multi-user behavior.

## Approval and completion

Ben approved this spec and the startup-repair amendment. The implementation plan must be aligned with the amendment and approved separately. The approved spec and subsequent approved plan must be committed through the normal PR workflow before implementation begins. Builder builds the single task, Reviewer reviews the settled head, Builder addresses defects, and PM confirms. Prover's live dev evidence and the named GitHub checks for that exact head are required before merge. Until then, any implemented result is code-complete, unverified.

No implementation, tests, deployment, or fresh live proof was performed while drafting this document. No security property beyond the stated source finding is newly claimed as verified. The five stream/masking/notification/writer/order boundary items are not applicable to this document-only draft; implementation must reassess them if its scope changes.
