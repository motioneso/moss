# Relay: #1319 Signed Moss Module Catalog (relay #13 — Task 1 source landed, tests pending)

**Build started.** Task 1 source committed at `d66c9bdbf` (on `0edb5fc15`/`fc525e53d`, this
branch/HEAD): `packages/module-registry/src/distribution/catalog-signing.ts` (new) +
`node.ts` barrel export. Implements the plan's exact Task 1 signatures (plan lines 271-305):
`CATALOG_SIGNATURE_FORMAT_VERSION`, `ModuleCatalogSignature`, `ModuleCatalogPublicKey`,
`MODULE_CATALOG_PUBLIC_KEYS` (frozen **empty** — no placeholder key; D8 says Ben provisions the
real one, reserved keyId `"moss-catalog-2026-a"` noted in a comment only), `signCatalogBytes`,
`verifyCatalogBytes`, `resolveCatalogSigningKey`, `resolveCatalogTrustedKeys`. Root
`pnpm typecheck` → `EXIT=0` (confirmed this session, not assumed).

Design notes for whoever verifies/extends this:
- New env vars (`MOSS_MODULE_CATALOG_SIGNING_KEY_ID`, `MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY`,
  `MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY`) are read directly via `env.MOSS_…` — **not** through
  `resolveMossEnv`, because that helper only derives a `MOSS_*` name from a legacy `JARVIS_*` one
  and none of these three ever had a `JARVIS_*` name (grep confirmed no other pure-`MOSS_`-only
  precedent exists yet in the tree; this is the first).
- `resolveCatalogTrustedKeys` checks the production+test-key refusal (ledger #22) **before and
  independently of** the override-active check — matches the plan's "own refusal, never borrowed"
  requirement and the "throws with the URL override set AND without it" test case.
- `verifyCatalogBytes` malformed-check order: object shape → formatVersion → algorithm → keyId →
  signatureBase64 base64-charset+64-byte-length check, all before any crypto call, so garbage
  input never reaches `createPublicKey`/`verify`. Wrapped in try/catch as a second backstop.

**Not done yet — this is the very next step, still Task 1:** the unit test file
`tests/unit/catalog-signing.test.ts` (plan lines 310-328, 7 bullet points of cases). Write it,
run `pnpm test:unit tests/unit/catalog-signing.test.ts`, confirm `EXIT=0`, commit, **then continue
to Task 2** (`scripts/publish-module-registry.ts` signing + workflow wiring, plan lines 330-374).
Relayed here at the context-meter 70% warning per `coordinated-build` step 3 — this is a context
checkpoint, not a blocker; no review round pending, build straight through per the prior relay's
note.

---

# Relay: #1319 Signed Moss Module Catalog (relay #12 — PLAN APPROVED, BUILD-READY)

**Plan is DONE and approved.** Commit `fc525e53d` (on `53ff42bcd`/`755cdcc0a`, this branch/HEAD)
is the final version — Ben ruled this revision round is final, no further Opus review follows.
This session independently verified all 4 round-6 blocking findings actually close against real
source (not just diff text): update-path gating (settings-module-registry-section.tsx:179-188),
UAT reality (provisioner.ts NODE_ENV=production, no JARVIS_MODULE_REGISTRY_URL under tests/uat/),
admin-auth ordering (routes-module-registry.ts:44,54,88,123), self-refusal design (mirrors
resolveRegistryIndexUrl's precedent at registry-source.ts:23-26). No defects found. Verdict sent
to Fable and jarv1s-09.

**Next relay: start the TDD build.** Read `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`
in full (it's the plan, self-contained), start at Phase 1 Task 1
(`packages/module-registry/src/distribution/catalog-signing.ts`). Task-scoped commits via the
`shared-checkout` skill (never `git add -A`/bare commit in this shared worktree). No further
review round is coming — build against the plan as written; if you find a real defect while
building, that's a normal build-time finding, fix it and note it, not a reason to re-open review.

---

# Relay: #1319 Signed Moss Module Catalog (relay #11, prior context below)

## Review-pass status (this session, build-1319-relay3)

Fable committed a **wholesale-fresh, non-incremental plan** as `755cdcc0a` (HEAD of this branch),
replacing the old 4-times-patched draft at the same path. Independently verified real/on-branch
before reading (git log/merge-base/show --stat). Read in full (631 lines).

**Review pass (spot-check style, not exhaustive per-task) result: plan looks sound.**
- D6 (test-key seam) premise confirmed: `JARVIS_MODULE_REGISTRY_URL` is real and
  production-refused at `registry-source.ts:23-26,42-45` — matches D6's design exactly.
- Ledger #19 structural claim confirmed: `tests/unit/module-distribution-pipeline.test.ts` has
  exactly 4 `downloadAndStageModule` tests and 3 `fetchRegistryIndex` tests, none serving `.sig`.
  **Nit**: cited line numbers (134,157,183,195) are off by 3-7 lines from the actual `it(`
  positions (131,149,167,192) — imprecise citation, not a false claim. Worth a quick fix, not
  blocking.
- `client.ts` signatures spot-checked exact: `ApiError` (status/message/code, no digestSha256
  yet — confirms Task 7 needs to add it), `readErrorBody`, `downloadRegistryModule(id, version?)`.
- `routes-module-registry.ts` disabled early-return currently lacks `catalogVerification`/
  `catalogDigestSha256` — expected pre-implementation state, Task 4 adds it. Not a plan defect.
- No `MOSS_MODULE_CATALOG_*` symbols exist yet anywhere in the tree — consistent with this being
  net-new, not yet built.

**Not yet done**: exhaustive per-task line verification of all 19 ledger items / all 8 tasks (only
spot-checked the two NEW items Fable flagged plus a few adjacent citations). If a successor session
continues the review, that's the remaining scope — otherwise this spot-check level, given nothing
found wrong beyond one line-number nit, is a reasonable basis to report "no blockers found" to
Fable/Coordinator and let the Opus review round (Coordinator's call, already messaged separately by
Fable) do the deeper adversarial pass.

**Next action for successor**: message `fable-1319-plan` (or Coordinator pane, re-resolve via
`herdr pane list`/`ListAgents` fresh — don't trust old pane ids) with the finding above, then hold.
No code. No git write actions without `shared-checkout` skill.

---

# Relay: #1319 Signed Moss Module Catalog (relay #10, prior context below)

- **Issue:** #1319, risk tier `security`. Approved by Ben 2026-08-17.
- **Plan file (OLD, superseded — do not keep patching):**
  `docs/superpowers/plans/2026-08-18-1319-signed-module-catalog.md`. 4 consecutive Opus review
  rounds all landed REVISE (see "Round history" below for grounded findings). Ben ruled: pause the
  patch-a-round cycle, write a fresh plan from scratch instead — see below.
- **CONFIRMED by Ben directly** (`~/.needs-ben/replies/1787038559551-jarv1s-1319-relay.md`, in
  reply to this session's own independently-queued ping, not just a relayed claim): **"yes,
  confirm. Fable writtes [sic] the plan."** This resolves both concerns raised earlier in this
  relay (the 3-hop claimed-coordinator chain `jarv1s-b4` → `jarv1s-1a` → `jarv1s-09`, and the
  `feedback-sonnet-not-plan-author` conflict). Independently corroborated three ways before the
  reply even landed: (1) `herdr pane list` — Coordinator pane `w1:pF6` / session
  `ea71a9d5-0a84-4719-8483-00723264ae80` matched exactly as claimed; a live Fable pane `w1:pF8`
  ("Fable: fresh #1319 plan", `agent_status: working`, correct worktree cwd) confirmed the spawn.
  (2) `git show bae494b97` — real commit, deletes a detailed `## Open: #1319 plan review — 4th
  round...` entry from `docs/coordination/AWAITING-BEN.md` matching the relayed findings
  near-verbatim (4 rounds, genuinely-correct fixes each time, options 1/2/3, recommends option 2).
  (3) current `docs/coordination/AWAITING-BEN.md` on disk has no #1319 entry. One loose thread
  (commit hash `df1718a7f` cited by `jarv1s-09` wasn't found touching this file via `git log`)
  never got reconciled but is now moot given Ben's direct reply.
- **Fable 5 is authoring the fresh plan** — pane `w1:pF8`, agent name `fable-1319-plan`, in this
  same worktree. This session's role once it posts: **review pass, not drafting.** No code either
  way.
- **No code has been written. Do not write code.**

## 5th review's findings (received, NOT yet applied — for whoever resumes)

Blocking: (1) `routes-module-registry.ts:92-97` `enabled:false` early-return omits
`catalogVerification`/`catalogDigestSha256` — 5th missed call site, 500s on GET while distribution
disabled, reds `pnpm typecheck`. (2) `apps/web/src/api/client.ts:1374-1394,177-185` —
`readErrorBody`/`ApiError` discard the 409's `digestSha256` before `onError` runs; override flow
dead. (3) `apps/web/src/api/client.ts:431-440` — real function is `downloadRegistryModule(id,
version?)`, not `downloadExternalModule(...)` as Task 7 names it, and has no
`overrideCatalogDigestSha256` param. (4) plan:593-594 vs `pipeline.ts:64-71` — plan's "insert after
the existing index-fetch block" reads as two independent fetches given its own snippet; violates
spec's "never pair entries or verification state from different snapshots".

Medium: (5) plan:881 uses `pnpm vitest run tests/integration/module-distribution.e2e.test.ts`
directly, bypassing `scripts/test-integration.ts`'s DB isolation — should be `pnpm test:integration
<file>` like Tasks 4/6 already correctly use. (6) `module-distribution-port.ts:39-49` — plan
doesn't state whether a failed fetch caches an "unavailable" snapshot into the 10-min
`registryCache` (today it correctly doesn't — should stay that way, state it explicitly). (7)
`registry-source.ts:68` uses `response.text()` but signing/digesting needs raw bytes — should be
`arrayBuffer()`.

Nits: stale 6th call site in `tests/unit/instance-modules-dedup.test.tsx:27-42` (harmless, `.tsx`
not typechecked); plan:477-478 references a nonexistent `installedVersion` identifier; plan:303-305
misdescribes the `.sig` fetch wrapper (real one is `createRegistryFetch`, unpinned when
`JARVIS_MODULE_REGISTRY_URL` is set); plan:602-603 dead init defended by a stale comment;
`.github/workflows/modules-registry.yml:51` `gh release upload --clobber` has no atomicity between
`index.json` and its `.sig`.

## Round 4 — all 5 findings fixed (verified against real source)

- **Blocking 1** (409 schema broke 2 sibling `HttpError(409,...)` throws on the same route):
  `catalogUnverifiedErrorSchema.required` narrowed to `["error"]` only (code/digestSha256 optional)
  — one schema now serializes all 3 body shapes the route produces.
- **Blocking 2** (test-collection / verification commands were false greens): confirmed
  `vitest.config.ts` never collects `packages/*/src/**`, and `module-registry`/`settings`/`shared`
  package.json files declare only `typecheck`, no `test`/`build`. Every new test in Tasks 1-5 is now
  placed under `tests/unit/` or `tests/integration/` (several extend files that already exist —
  `publish-module-registry.test.ts`, `module-registry-rows.test.ts`,
  `module-distribution-pipeline.test.ts`, `module-registry.test.ts`,
  `module-distribution.e2e.test.ts`). Every verification command now uses the real root scripts:
  `pnpm test:unit tests/unit/<file>.test.ts` (confirmed via full read of `scripts/test-unit.ts`) and
  `pnpm test:integration tests/integration/<file>.test.ts` (confirmed via full read of
  `scripts/test-integration.ts` — auto-isolates a `jarvis_test_<pid>_<random>` DB unless
  `JARVIS_PGDATABASE` is set). Task 6's exact file is the one remaining pick between two real
  candidates (`tests/unit/module-reconcile-plan.test.ts` vs.
  `tests/integration/module-reconcile-target-guard.test.ts`) — stated inline in the plan as that
  task's first action, not a false-green risk.
- **Blocking 3** (existing real call sites of changed types not enumerated): Task 4 now has an
  "Existing call sites requiring updates" note naming all 4 — `module-registry-rows.test.ts`'s
  `derive()` helper and its direct-construction test, `tests/e2e/settings-modules.spec.ts`, and
  `tests/unit/settings-instance-modules-pane-render.test.tsx`'s 3 fixtures — each with the exact
  field(s) to add.
- **Medium 4** (`registryUnavailable` definition contradicted itself across 3 plan locations): one
  explicit rule now used everywhere — `registryUnavailable === (catalogVerification ===
  "unavailable")`.
- **Medium 5** (Task 6 test asserted a literal `"catalog-unverified"` string that never appears in
  the logged `error.message`): fixed to assert `failureReason` is non-null in the parsed JSON
  payload instead.

## Next concrete step for successor

1. Report "round-4 complete, ready for re-review" — `jarv1s-b4` sent the round-4 findings and is the
   established reviewer for this cycle; `jarv1s-1a` (a session claiming coordinator succession from
   a "take-48" pane) gave the instruction to finish these edits and said they'd spawn the review.
   Notify both: confirm to `jarv1s-b4` their findings are fixed, and reply to `jarv1s-1a` per their
   explicit ask.
2. **Continue holding — no code — until approved.** Whether `jarv1s-b4`'s approval alone is
   sufficient, or a separate Coordinator pane also needs to sign off, is still open (carried from
   relay #6/#7, unresolved) — surface this explicitly rather than assuming either path.
3. On confirmed approval: TDD build task-by-task, task-scoped commits (`Co-Authored-By: Claude`,
   `Part of #1319`), pre-push trio + rebase before every push, `coordinated-wrap-up` with
   isolated-DB gate + live-path UAT proof. Shared worktree — use `shared-checkout` skill for any git
   action (none taken yet this entire relay chain — all edits are to the plan doc only).

## Reminders

- No DB migration for #1319 — do NOT claim migration 0185 (reserved for #1586).
- This is relay #8. Prior relays each applied one review round's fixes and re-sent for review —
  ordinary context-budget cycling given the CLAUDE.md context-diet checkpoint threshold, not a
  stall. Decisions made in prior rounds are final; don't re-verify them unless a reviewer explicitly
  flags one broken again.
- Two sessions (`jarv1s-b4`, `jarv1s-1a`) have both acted as "coordinator" this issue at different
  points — worth flagging to Ben/the human coordinator if a 5th round surfaces yet another identity
  claiming the role, since that pattern itself may indicate stale pane state rather than a real
  handoff.
