# #1533 chat surface build — relay11 handoff

Supersedes relay10. Same worktree/branch: `build/1533-chat-surface-routing`, HEAD `99e3d0257`
(gate green at `80f01f537`, `verify:foundation` FINAL rc=0, confirmed relay10).

## State

- Phase 3: DONE (unchanged).
- Phase 4, gate: DONE (unchanged from relay10).
- Phase 4, **sensitive-tier check: DONE, clean.** relay10's `git diff --stat main...HEAD`
  showed 132 files because local `main` is stale (`shared-main-tree-lags-origin` trap —
  local main `1896fce1a`, `origin/main` `fbf6c89f8`). Correct diff is
  `git diff --name-only origin/main...HEAD`: 21 files — exactly the 5 claimed production
  files (`apps/web/src/api/client.ts`, `apps/web/src/api/query-keys.ts`,
  `apps/web/src/chat/chat-drawer.tsx`, `apps/web/src/chat/chat-model-pill.tsx`,
  `apps/web/src/shell/app-shell.tsx`), 4 test files, and this branch's own handoff/plan docs.
  **No AccessContext/RLS/persistence/gateway-contract/migration files touched.**
- Phase 4, **live-path proof: BLOCKED, real blocker, not started.** See below — do not attempt
  to fake or approximate this evidence.
- Draft PR: not opened (blocked on live-path proof per project's live-path gate rule).

## Live-path proof blocker (confirmed, not a code bug)

The spec's 7-step procedure (spec doc lines 296-319) requires a *real* chat-model turn that
decides to call `job-search.criteria.set`, producing a real approval card to screenshot. That
needs a working `auth_method='cli'` chat provider backed by a running, authenticated
`@moss/cli-runner` process — there is none available on host-dev right now:

- Only cli-runner process on this host is bound inside the **prod** `Moss` container
  (`ghcr.io/motioneso/moss:edge`, port 1533) — confirmed via `docker ps` + `/proc/<pid>/environ`
  read-only inspection (no prod process touched/restarted). Off-limits per hard invariant.
- `ben@ben.com`'s dev-DB provider configs (`app.ai_provider_configs`, DB `jarv1s`): `anthropic`
  (default) and `google`, both `auth_method='cli'` — need a live cli-runner, which host-dev
  doesn't have.
- The only `auth_method='api_key'` rows active in the dev DB are 3 "UAT Fake Provider" rows
  owned by the synthetic UAT fixture user (`00000...001`), no `base_url`, canned — not usable
  for a real host-dev browser session, and per `job-search-board.uat.spec.ts`'s own
  `REAL_CHAT_CONFIGURED` gate, a fake provider can't reliably choose which `job-search.*` tool
  to call anyway.
- I have no API key credential in my environment to stand up a throwaway `api_key` provider as
  a workaround, and standing up a fresh **authenticated** `cli`-auth provider needs a real
  interactive OAuth login I can't perform headlessly.
- This exactly matches [[host-dev-install-seam-env-pair]] memory's prior finding for #1379's
  live-path proof (2026-08-06): host-dev chat handoff is provable, but no model reply/tool call
  ever arrives, because there's no cli-runner. Standing up one for real is [[uat-real-chat-onboarding-cli-tools-missing]]'s
  active, unsolved problem — owned by issue #1121 (session `issue-1121-relay3`, pane `w1:p7D`,
  same herdr workspace), not something to duplicate inside this task.

**Not faked, not approximated.** No screenshot, no network evidence, no action-row id exists for
this step. Everything else in this doc is real and independently verified.

## Next

1. This step is blocked on #1121 delivering a working real-chat path for host-dev/UAT (or on
   someone provisioning a throwaway `api_key` provider + credential for `ben@ben.com` on the
   shared dev instance). Coordinator notified via herdr this relay — do not re-attempt without
   one of those landing.
2. Once unblocked: stand up host-dev API+web (ports 3002/3004 or similar were free at relay10's
   scan — re-scan, may have changed), sign in `ben@ben.com` / `jarvistest123!`
   ([[dev-instance-lan-spinup-trusted-origins]] has the trusted-origins/auth-secret recipe),
   then execute spec lines 296-319 exactly via a real Playwright browser (screenshot + network
   capture required, reload/timeout explicitly disallowed as proof).
3. Draft PR only after live-path evidence is real and attached.

## Standing instructions (from boot brief, still governing)

- Coordinator: re-resolve fresh via `herdr pane list`/`herdr agent list` before messaging —
  `SendMessage` to a herdr-registered name fails; use `herdr agent prompt <name> "..."`.
- Relay again at the next 70% context warning or immediately on any compaction summary.
- Use `scripts/run-gate.sh`, never bare `pnpm verify:foundation`.
