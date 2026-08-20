# Relay: #1258 dev-instance provisioning, Phase 4

Written 2026-08-20 by the Phase 3 build session (pane w1:pGK) on hitting its relay trigger.
Phase 3 is finished, committed and green. Phase 4 has not been started.

## Where the work lives

- Issue: **#1258**. Branch: **build-1258-dev-instance-provisioning**, in the main checkout
  `~/Jarv1s` (shared with other live sessions — see Ground rules below).
- Spec: `docs/superpowers/specs/2026-08-19-1258-dev-instance-provisioning.md`
- Plan: `docs/superpowers/plans/2026-08-19-1258-dev-instance-provisioning.md`
  Read it **by section** for the task in front of you. Phase 4 is tasks T19-T22 under
  "### Phase 4"; the exact signatures you need are in section 5 (Contracts).
- Coordinator: the Herdr pane labelled **Overnight Coordinator**, session
  `131d41fb-fb83-4edf-8226-d2d5a704ff5c`. Resolve its pane number fresh every time
  (`herdr pane list`); pane numbers reflow. Sign every message with your own pane id.

`node_modules` already exists — do **not** re-install. `[ -d node_modules ] || pnpm install`.

## What is done

Phases 1-3, all committed. Latest: `15fbe82f8 feat(1258): cli-runner probe/start and token
persistence (T15-T18)`.

- `doctor` (read-only checkup) with eight checks, each carrying a repair string.
- `provision`'s database half: admin account created through the real signup route, provider and
  chat-model rows through `ensureDefaultChatModel`.
- `provision`'s file half: `scripts/dev-instance/cli-runner.ts` (probe with a 3s deadline, bounded
  start) and `scripts/dev-instance/cli-token.ts` (writes the provider login token through the
  cli-runner's own 0600 store, returns only a changed boolean).

Green as of the relay: 14 integration tests (`/tmp/1258-t17-t18-run2.log`, rc=0), 33 unit tests
(`/tmp/1258-unit.log`), whole-repo `pnpm typecheck` (`/tmp/1258-typecheck.log`, exit 0), and
prettier + eslint clean on the Phase 3 files.

## Facts you would otherwise have to rediscover

- **The socket directory question is settled and needs no decision.** `/run/jarv1s` exists on this
  host (`drwxrwx--- ben ben`) and survives reboot via `/etc/tmpfiles.d/jarv1s.conf`. The plan's
  OQ-1 lists this as a blocker owned by Ben; it is already satisfied. Nothing to escalate.
- **The tool deliberately never takes root.** When the socket directory is missing it names the
  one-time setup command (`RUN_DIR_REPAIR_COMMAND` in `cli-runner.ts`) and does not create it, and
  does not bother spawning the runner. The coordinator agreed this shape. If you find yourself
  wanting the tool to do it automatically with sudo, stop — that is a Fable decision.
- **Nothing in this tool may wait indefinitely.** `RpcConnection.ensureConnected()` in the chat
  package retries forever by design; that is correct for chat and fatal for a checkup. It is now
  called from exactly one place, behind a deadline. Every new step you add wants a deadline and a
  plain "not reachable", not an indefinite wait. There is no shared retry helper to fix.
- `scripts/dev-instance.ts` (the CLI entry itself) **does not exist yet** — Phase 4 creates it.
- `package.json` has `db:down` at line 30; `dev:instance` and `db:reset` are not there yet.

## Open, not yours to decide — already with the coordinator for Fable

`scripts/dev-instance/secrets.ts:49` calls gpg with `--batch`, which tells gpg never to prompt. The
spec's stated protection is that the decrypt step stays interactive so an agent running `provision`
cannot silently walk off with the token. With `--batch` the call either fails outright or succeeds
silently from a cached passphrase, and the silent-success case is the one the protection was meant
to stop. Raised, left unchanged, awaiting a ruling. Do not change it on your own judgement.

## What is left — Phase 4 (T19-T22)

Test-first, one commit per task, explicit paths.

1. **T19** — create `scripts/dev-instance.ts` exporting `runDevInstanceCli(argv, env)`. Order is
   fixed: parse command, then `assertDevEnvParity(env)`, then resolve URLs, then
   `assertTargetIsDevInstance(urls.app)`, then open handles, then dispatch. `process.exit` only in
   the self-invoke guard. Test in `tests/unit/dev-instance-guard.test.ts`: with `NODE_ENV` set and
   the connection env pointed at an unreachable host, it returns non-zero *with the parity error*,
   proving no connection was opened.
2. **T20** — `tests/unit/dev-instance-not-bundled.test.ts`: neither `apps/api/src/server.ts` nor
   `apps/worker/src/worker.ts` reaches `scripts/dev-instance` in its import graph.
3. **T21** — `scripts/dev-instance/fix.ts` with `runFix(deps, report)`; two actions,
   `flag-instance-default` and `purge-uat-fixture-rows`. Tests in
   `tests/integration/dev-instance-doctor.test.ts`. On a healthy database every action reports
   `changed:false` and writes nothing.
4. **T22** — add `dev:instance` and `db:reset` to `package.json`, and update the nine doc hits that
   recommend a bare `pnpm db:down`. The exact file:line list is in the plan under T22, including
   the two hits to leave alone. Record the deletion of the old UAT credential file (spec Decision 4)
   in the PR body as an operator step.

Phase 5 (`providers`, `reset`) is deliberately deferred. Do not start it.

## Ground rules that still apply

- **Shared checkout.** Never `git add -A` or `git add .`, never a bare `git commit`. Read the diff
  of any file you did not create, commit by explicit path, then `git show --name-only HEAD` and
  confirm the file list is exactly yours. There is a stray root-level `make-admin.ts` that belongs
  to someone else — leave it, and everything else you did not create, alone.
- **Never run the full gate or any database-touching test without the `verify-gate` skill.** An
  unscoped run points at the live dev database. Never pipe gate output; write it to a file with a
  `### FINAL rc=$?` sentinel and read the real exit code.
- The full gate currently fails at its very first check for a reason unrelated to this branch — the
  style checker's own exclude list is missing an entry. It is with Fable. Do not fix it and do not
  work around it; run type-check and tests directly for real signal on your own work.
- **Never bypass the database privacy rule.** Anything read back out of the database is read as the
  real user identity that owns it. If you cannot read something back safely, that is worth stopping
  and asking about, not routing around.
- Every PR fills in the Release note section of the template.
- **Nothing merges tonight and #1258 is not marked done** without both a green gate and a live
  proof through the real interface on a live dev instance. If you reach all-green without that
  proof, the honest status is *code-complete, unverified* — say so plainly and leave the PR open.
- Real product or architecture forks go to the coordinator for Fable. Ben is asleep; do not wake him.
- Report real progress to the coordinator as you go; do not go quiet for 40+ minutes. When you start
  something long, give the coordinator the output file path in the same message so it can watch.

## Housekeeping

Throwaway gate database `jarvis_gate_1258p3` still exists — reuse it (DROP + CREATE each run) and
drop it when Phase 4 is finished.
