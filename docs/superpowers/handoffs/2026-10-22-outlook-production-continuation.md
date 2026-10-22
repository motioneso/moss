# Continue Outlook account setup toward production readiness

## Start

1. Work only in your assigned checkout, `~/Jarv1s/.claude/worktrees/outlook-production-next`,
   local branch `moss/outlook-production-next`. Install dependencies with `pnpm install`.
2. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, then these authoritative docs:
   - `docs/superpowers/specs/2026-10-22-outlook-user-setup-design.md`
   - `docs/superpowers/specs/2026-10-22-outlook-user-setup-build.md`
   - `docs/superpowers/plans/2026-10-22-outlook-user-setup-progress.md`
   - `infra/outlook-browser/README.md`
3. Check the live task #3570 and draft PR #3571. Search Hindsight for relevant decisions, verify
   them against current source, and prefer the codebase-memory graph for discovery. The predecessor
   index is `home-ben-moss-o365-talk`; your checkout may need its own index. Python coverage in
   the predecessor graph was insufficient, so bounded source reads were needed for the broker.
4. Choose the next unfinished runtime acceptance requirement from the progress record. Effective
   managed-browser policies and the remaining network acceptance are useful next slices. Build
   the missing protection or test, demonstrate the relevant negative control, then update the
   same progress record and PR with precise evidence. Continue through the remaining runtime,
   authenticated setup and deployment work in reviewable increments; a report alone is not the task.

Ben explicitly asked to continue production-readiness work and then to hand it to a fresh session.
The user flow is approved. Routine implementation and reversible isolated verification can proceed
without another planning approval. Production deployment/migration remains a separate action.

## Branch ownership and delivery

Your base includes the predecessor's pushed feature work and this committed handoff. You own all
further implementation on this task. The predecessor will stop editing once you start. Other agents
may be working elsewhere: preserve their files and follow the shared-checkout skill before commits.

Continue **existing draft PR #3571**, whose remote head is `moss/outlook-user-setup-design`.
Your isolated local branch has a different name to avoid checking out one branch twice.
Use explicit commits, then a normal fast-forward push:

```sh
git push origin HEAD:moss/outlook-user-setup-design
```

Check that the remote head is your ancestor before each push. If it advanced independently,
inspect the difference and coordinate instead of forcing. Keep your local branch name and
checkout; do not create a competing PR or overwrite the predecessor's checkout. Keep the PR draft
until all required acceptance is genuinely met. Existing authorization to merge when ready does
not waive the live-path or security evidence gates.

## Current checkpoint

Merged to main: PR #3568 delivers read-only primary Outlook calendar import, yesterday through
the next 30 days with five-minute refresh, source attribution, freshness/uncertainty and the initial
operator-bound connection. PR #3569 carries release notes. Preserve that working integration.

Draft #3571 includes lifecycle migration 0332, owner/generation state and leases, durable cleanup
queues, a private Python lifecycle service, rootless Podman/profile primitives, controlled HTTPS
egress, and a pinned candidate Chromium image. It is not yet a working self-service product.
The progress record is the detailed source of truth; in particular, the lifecycle sweeper is not
scheduled, the service is not installed, and viewer/API/session authorization is unfinished.

Latest implementation checkpoint: `cbc530ecd808a506ec78c2a4c27a40622ab82bc9`.
It adds `infra/outlook-browser/tests/verify_podman_service.py`, extending the prior engine stand-in
proof with actual rootless Podman/candidate Chromium at deterministic command boundaries:

- SIGKILL after successful creation but before broker acknowledgment recovers the allocating
  record and profile marker, and checks Chromium namespace/seccomp diagnostics.
- SIGKILL after container removal but before profile-volume deletion completes cleanup before
  listening again, rejects reuse of the reference, and preserves the second runtime's marker.
- Changing only KillMode to process makes the positive command-death assertion fail. Releasing
  that orphan then creates real candidate Chromium after broker death.

The disclosed test-only PATH barrier delegates to the actual engine; it is not shipped in the
service/image. This proves selected acknowledgment boundaries, **not arbitrary crashes within
Podman/storage transactions**. Candidate-image source bytes are checked. No real account was used.

Native x86_64 candidate for this receipt:
`sha256:c958299592f86f55196d8bdd07ce72f8f9669b656410de8fbf8990abc021e507`.
The disposable image/store was deleted, so rebuild from the checked-in inputs if needed.

Verification on that checkpoint: `pnpm test:outlook-runtime` passed 38 tests plus twelve
guard-removal controls; actual positive and negative service/Chromium probes exited 0; the existing
stand-in service proof exited 0; full `pnpm verify:static` exited 0; working tree clean.
Evidence: PR #3571 comment `6347781158`; task #3570 comment `6347783160`.

## Remaining acceptance and product work

Follow the full build spec and progress record. The principal unfinished areas are:

- Maintained browser release/security updates, effective policy enforcement, ARM64/supported-host
  coverage, remaining browser network checks and public host/application ingress denial with refresh.
- Engine-internal crash limits beyond the tested boundaries and release-image acceptance.
- Private transport installer/deployment mounts and identity mapping, optional-runtime compatibility,
  and lifecycle scheduling. Every affected deployment config belongs in the same feature PR.
- Actual Moss browser-session authentication, same-origin/CSRF and immediate revocation, viewer and
  collector leases, fixed frame/input operations, owner setup and rendered identity confirmation.
- Calendar binding and generation checks, atomic legacy handover, disconnect removing imported
  events and durable profile cleanup; Settings/viewer UI and truthful app-map declarations.
- Isolated integration gates, two-user live UI acceptance, human Microsoft sign-in/MFA, phone and
  Firefox usability, and empty install/update/uninstall proof. Never infer readiness from CI alone.

## Verification and operating traps

Use the repository verify-gate skill before any database-touching tests. Required scoped integration
lane: `test:integration:3570`; narrow negative-control lane: `test:integration:3570:lifecycle`.
Read design-system guidance before UI work. Record security assertions failing with protection
removed. Keep evidence bounded and private; full-page screenshots are not acceptance artifacts.

The system filesystem was nearly full. Use a disposable store on a roomy Linux filesystem for
browser builds, rather than adding gigabytes to the default store. On this host an environment-only
storage override was ignored: pass explicit engine root/runroot consistently and verify `podman info`
before building. The new verifier accepts `--engine-root` and `--engine-runroot` together.
All predecessor test containers, volumes, units, image stores, logs and receipt scratch files are gone.

After images/resources are removed, a task-only `storage/overlay` bind mount can remain inside the
rootless namespace. Inspect that namespace's mountinfo; unmount only the exact disposable path via
the same configured `podman unshare`, then remove the store. Podman may recreate empty metadata when
the command exits; remove those owned remnants after it exits. Preserve shared/default stores.

Some terminals lack the user service-manager environment. For disposable user-systemd checks use:

```sh
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
```

The unrelated local `updateMoss` command is repaired and Ben verified it works. Its updater service
now uses Docker API 1.44, and the script initializes its own user-bus environment. It is outside
the repo and needs no further work. Do not run it as a development verification step.

Preserve the legacy live connection; production port 1533 is never a test target. Claims about
profiles, authentication material, isolation or cleanup must be limited to the paths actually
followed and tested. Never print real account content or credentials. Real Microsoft sign-in/MFA
requires a human in the eventual dedicated dev viewer; do independent work until that boundary.
Claim dev ports with `devports`. Keep the progress record current, commit/push preserved work,
clean task resources, and report accurately what remains. Avoid repeated relay chains: scope each
context to a concrete slice and leave a durable checkpoint for any later continuation.
