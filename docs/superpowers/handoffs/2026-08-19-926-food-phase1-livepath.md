# Handoff — #926 Food Phase 1, live-path gate

**State: code-complete, unverified.** PR #1716 open against `main`, branch `food-phase1-926`.
Everything below is build-verified; nothing is live-verified.

## What is done

Tasks 1-7 of `docs/superpowers/plans/2026-08-18-926-food-module-build.md`, six commits:
`9053d09` foundation → `0d56639` tools+estimator+worker → `cb3e468` page → `84c2533` worker
entrypoint fix → `98322b4` tests+permission fixes → `cd22734` gate fixes+standards.

39 Food unit tests green. `pnpm verify:foundation` reached step 11 of 15 against isolated DB
`jarvis_gate_food926` (dropped after). Steps 12-15 unreachable on this box — see
`module-sdk-worker-tests-fail-locally-green-in-ci` memory. CI adjudicates those.

## The only remaining work: live-path gate

Three behaviours have no unit-test proof and need a real instance:

1. **Two-actor privacy** — actor B cannot read/list/summarize/correct actor A's meals; nor can an
   admin. Needs real Postgres RLS.
2. **Module isolation** — Food cannot read `app.wellness_*`; Wellness cannot read `app.food_*`.
3. **Lifecycle** — Food absent before install; nav entry and tools appear after install+enable;
   disable hides surfaces and tools while rows are retained. Through the platform contract.

`tests/e2e/food-log-and-read.spec.ts` holds the 9-step UAT script as a checked-in `test.fixme`.
Mocking the tool responses would test the mock, not the assembled path — do not "fix" it that way.

## Blocker as of 2026-08-19 07:30

**The dev instance is down.** Port 5173 listens but returns 404 (stale Vite, pid 1550288 at time
of writing); nothing on :3000. Stand it up before anything else — an open port is not a live
instance, which is the exact trap in `feedback-dev-environment`.

Recipe: run from source in `~/Jarv1s` on this branch — `pnpm install` → `pnpm db:migrate` →
`pnpm dev:api` (:3000) → `pnpm dev:web` (Vite :5173, `--host` built in). LAN URL
**http://192.168.50.36:5173**. Login `ben@ben.com` / `jarvistest123!`. Postgres
`jarv1s-postgres:55433`, DB `jarv1s`, schema `app`. **`:1533` is PROD — never target it.**

Food is a downloaded-module artifact package, so it needs `pnpm build:external:food` and an
install through the real module-install path, not a workspace link. `dist/` is gitignored.

## Traps already paid for — do not re-derive

- **No enqueue RPC exists** (R15). No handler can self-enqueue; the only queue trigger is the
  manual-run route gated on `allowManualRun`. Estimation is synchronous on the tool path.
- **Read-risk tools cannot call AI** (R16, `forbidden_ai_call`), and module pages may invoke
  read-risk tools only. The Food page cannot trigger an estimate until #1699. Do not expect a
  page interaction to produce an estimate.
- **Assistant tools ARE worker handlers** — one registry, one subprocess, looked up by handler
  key. A handler absent from the map is unreachable whatever the manifest declares.
- **Modules have no transactions.** Correctness rests on the monotonic `estimate_revision` CAS
  column.
- **The bundler emits `dist/worker.js`**, not `dist/worker/index.js`, from entry
  `src/worker/index.ts` (`scripts/build-external-module.ts:20-21`).
- **Never edit `external-modules/food/sql/*` again** — safe only until first install; the runner
  hash-checks applied files. Add a new file instead.

## After the gate passes

Record the live-path evidence on PR #1716 per `docs/DEVELOPMENT_STANDARDS.md`, then
`gh pr merge 1716 --squash --auto` (never `--admin`, blocked by a repository ruleset). Then comment
#926 and move #1701 to Done on board project 2 (item `PVTI_lAHOADqkaM4BarLAzg3F-wQ`, status field
`PVTSSF_lAHOADqkaM4BarLAzhVhA6I`, Done option `98236657`).

Stage-scoped blockers that do **not** gate Phase 1: #1694 data export (gates overall live
completion), #1695/#1696 photo path, #1697 correlation path, #1699 page write path.
