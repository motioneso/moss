# Manual-run job idempotency race

**Date:** 2026-08-11

**Status:** Draft — awaiting Fable review

**Issue:** #1547 (build child; no parent roll-up)

**Source:** flaked in CI on unrelated PR #1531 (run 31381913450, attempt 1) — `tests/integration/job-search-worker-surface.test.ts` "test 6" saw a duplicate manual-run return a real job id (`97151406-c9ca-48e7-8dcf-2760497e1c8b`) instead of `null`.

**Grounded on:** `origin/main` = `7aa85f628`, read directly in this tree: `apps/api/src/external-module-jobs.ts`, `packages/jobs/src/module-jobs.ts`, `packages/jobs/src/pg-boss.ts`, `tests/integration/job-search-worker-surface.test.ts`, `tests/integration/external-modules-routes.test.ts`, and `package.json` (`pg-boss@^12.18.2`).

**Pre-build grounding gate:** rebase on the then-current `main`, re-read the owned files, and replace any stale line references before implementation. Confirm the installed `pg-boss` version and its actual `singletonSeconds` semantics from `node_modules` at build time — this spec's account of pg-boss internals is inferred, not read (see Process notes).

## Decision summary

This spec authorises **one** implementation PR for #1547. That PR must land a deterministic red-then-green reproduction at the real HTTP route, then fix the defect at the shared idempotency boundary.

The spec deliberately **does not choose the fix**. Reproduction comes first: the red test is what tells the implementer which boundary actually broke, and only then is the narrowest fix selectable. What the spec locks is the reproduction's rigour, the contracts the fix may not change, and the boundary it must be made at.

## Current-state grounding

| Finding                                   | Current behaviour                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual-run route                          | `POST /api/modules/:moduleId/queues/:queueName/run` in `apps/api/src/external-module-jobs.ts` resolves the actor, requires `queue.allowManualRun`, validates a `jobKind`/`params`-only body, then calls `sendModuleJob`.                                                                                                                                                                                            |
| Dedupe request                            | The route passes a `singletonKey` composed as `manual:<moduleId>:<queueName>:<actorUserId>` together with `singletonSeconds: MANUAL_RUN_SINGLETON_SECONDS`, which is `5` — added by #965 to catch accidental double-clicks without blocking an intentional rerun.                                                                                                                                                   |
| UX contract                               | Always HTTP `202`. Body is `{ jobId: string }` when enqueued and `{ jobId: null }` when pg-boss rejects the send as a duplicate.                                                                                                                                                                                                                                                                                    |
| Send-side wrapper                         | `sendModuleJob` (`packages/jobs/src/module-jobs.ts:93`) builds the metadata-only payload, runs `assertModuleJobPayload`, and returns `boss.send(queue.name, payload, options)` — passing `singletonKey`/`singletonSeconds` straight through.                                                                                                                                                                        |
| There is no other idempotency layer       | Nothing between the route and pg-boss performs an idempotency check. **pg-boss's native singleton IS the shared idempotency boundary today.**                                                                                                                                                                                                                                                                       |
| Dedupe enforcement                        | pg-boss enforces the singleton with a policy-filtered partial unique index over the queue name, the singleton key and a `singleton_on` bucket — the policy filter is documented in `packages/jobs/src/pg-boss.ts:251-256`. `singleton_on` is a server-side timestamp floored to a fixed `singletonSeconds` grid anchored to the Unix epoch, **not** a sliding window measured from the first call.                  |
| The defect                                | Two sends whose database inserts land in _different_ five-second epoch buckets produce different `singleton_on` values, both satisfy the unique index, and both return a job id — even though they are simultaneous from the user's point of view. A double-click at wall-clock `T = 4.98s mod 5` and `T = 5.02s mod 5` is not deduped. Dedupe therefore succeeds only by luck of where the pair falls on the grid. |
| The flaking test is collateral, not proof | `tests/integration/job-search-worker-surface.test.ts:236-295` ("test 6") issues two **sequential** real `server.inject` POSTs and expects the second to be `null`. It is real-timed, not clock-controlled, so under CI load the gap between its two inserts can itself straddle a bucket edge — which is exactly what happened in the cited run. It demonstrates the bug but cannot prove it on demand.             |
| Same shape elsewhere, out of scope        | `tests/integration/external-modules-routes.test.ts:153-168` (synthetic `acme-widgets.manual` queue) has the identical sequential pattern and the same latent flake risk. #1547 does not own it; it is named here only so a later reader does not mistake its silence for absence.                                                                                                                                   |

## Tier and dependencies

**Tier:** routine, with a concurrency-correctness emphasis. No RLS classification changes, no migration, no user-facing feature.

**Dependencies:** none. Discovered on PR #1531, which has no causal path to this code (#1531 touches AI error redaction and gateway tests only) — **do not implement the fix on #1531**. If #1531's CI reproduces the flake again it stays blocked until #1547 lands or is revalidated.

## Exclusive owned surface

- `apps/api/src/external-module-jobs.ts`
- `packages/jobs/src/module-jobs.ts` — only if the chosen fix places the shared idempotency check here rather than relying on pg-boss's native singleton
- `tests/integration/job-search-worker-surface.test.ts` — the new deterministic race case is an **additional** `it()`; test 6 is not replaced
- A new dedicated integration test file under `tests/integration/` **instead of** the line above, at the implementer's discretion, if the boundary-forcing harness is heavy enough to deserve its own `describe`

Do **not** touch `tests/integration/external-modules-routes.test.ts`. Do not widen into unrelated queue, worker, or module-registry files; any such need is a spec amendment, not opportunistic cleanup.

## Locked reproduction contract

The implementation PR must land a test that fails on the pre-fix tree **every run**, not occasionally.

1. **Real surface.** Exercise the actual HTTP route through the real API server — match test 6's existing harness pattern (`server.inject` against the real registered routes, real database, real pg-boss). No mocked boss, no direct `sendModuleJob` call, no stubbed clock substituted for pg-boss's server-side `now()`.
2. **Two genuinely concurrent manual-run calls** for one actor, module and queue — the same logical run a double-clicking user produces.
3. **Deterministically straddle the bucket boundary.** The two calls' pg-boss inserts must be forced onto opposite sides of a real five-second epoch-aligned `singleton_on` boundary. Timing luck is not acceptable: a test that reproduces "usually" is the flake again with the assertion inverted.
4. **Assert the pre-fix failure precisely:** both calls return `202` with a non-null `jobId`, and two rows exist for that queue in the run window. A test that merely asserts "sometimes two" does not satisfy this.
5. **Assert the post-fix behaviour:** exactly one call returns a `jobId` string, the other returns exactly `{ jobId: null }`, both with status `202`, and exactly one metadata-only job row exists for that profile and run window.
6. **No hiding.** No arbitrary sleeps, retries, tolerance bands or widened timing thresholds may be used to make the post-fix assertion pass. This constraint governs the _assertion_; see the note below on how the harness is allowed to schedule its two requests.
7. **Red then green in one PR.** The new test lands failing-by-construction against the unfixed behaviour and is flipped green by the fix in the same PR. The PR must show both states — the recorded red run against the pre-fix tree and the green run after — not merely a green final gate. Do not ship the test disabled, skipped, or `todo`.

### Proposed boundary-forcing technique (open engineering question)

Compute the next boundary as `floor(Date.now() / 5000) * 5000 + 5000`, then schedule request A to be issued a small margin before it and request B the same margin after it, deriving the margin from a round-trip sample measured in the test itself rather than hard-coding a constant. Await both together so they are genuinely in flight concurrently.

This is a _computed wait for a real periodic anchor_, not the "arbitrary sleep" the acceptance criteria forbid — that criterion is about not masking the race after the fix, not about how the pre-fix harness aligns its two requests. **This technique is the one open question in this spec.** The implementer may substitute any mechanism that is genuinely deterministic (for example, controlling the database clock the inserts observe, or asserting on the observed `singleton_on` values and failing the test if the two inserts did not in fact straddle a boundary). What is not negotiable is criterion 3: the reproduction may not depend on luck. If no deterministic mechanism proves reachable, stop and escalate rather than shipping a probabilistic test.

## Locked fix contract

The fix is **not** selected by this spec. It is selected during implementation, after the red test reproduces and shows which boundary broke. These bounds are binding on whatever is selected.

**Must preserve exactly:**

- The singleton key composition `manual:<moduleId>:<queueName>:<actorUserId>`. What counts as "the same logical run" does not change: it stays scoped to actor plus module plus queue and must not start keying on `params` or `profileId`. That two different profiles for one actor on one queue currently dedupe against each other inside the window is existing, deliberate behaviour and is **not** in scope to change.
- The UX contract: HTTP `202` always, `{ jobId: string }` on enqueue, `{ jobId: null }` on duplicate. No new status code, error body, or field.
- The metadata-only job payload invariant and the five-second intent from #965 — catch the double-click, do not block a deliberate rerun.

**Must be fixed at the shared idempotency boundary** — the place where the manual-run send decides that two calls are the same run. Not by retrying in the route handler, not by widening a timing threshold, not by loosening the new test's assertions.

**Candidate directions, none selected:**

- **(a) App-level idempotency ahead of `boss.send`,** scoped by the same singleton key, using a real database constraint or advisory lock instead of pg-boss's epoch-bucketed `singletonSeconds`. Narrowest in behaviour, but adds an owned surface in `packages/jobs`.
- **(b) A pg-boss option or version offering a sliding-window singleton,** if one exists on `pg-boss@^12.18.2`. **Unverified** — `node_modules` was not readable in the authoring session. Checking this is a required first step at implementation time, because if it exists it is almost certainly the smallest fix.
- **(c) A debounce keyed off the previous call's recorded timestamp** rather than a fixed epoch grid, so the window slides from the last accepted run.

Pick the narrowest direction the red test's evidence actually supports. If the evidence contradicts this spec's account of pg-boss's bucketing, that is a finding worth reporting, not worth routing around.

## Focused acceptance

Verbatim from issue #1547:

- [ ] A red test deterministically demonstrates two concurrent/immediate manual-run calls both returning non-null job ids before the fix.
- [ ] After the fix, exactly one call returns a job id and the duplicate returns `{ "jobId": null }`.
- [ ] Exactly one metadata-only job exists for the profile/run window.
- [ ] Existing manual-run API/worker surface tests remain green.
- [ ] No arbitrary sleeps, retries, or widened timing thresholds hide the race.

Additional to this spec:

- [ ] Test 6 in `tests/integration/job-search-worker-surface.test.ts` stays green and unmodified in intent — still two sequential near-simultaneous real POSTs. It may not be rewritten into the new deterministic shape, nor relaxed, to make it pass.
- [ ] The singleton key composition and the `202`/`{jobId}`/`{jobId: null}` contract are unchanged in the diff.
- [ ] The PR records both the pre-fix red run and the post-fix green run of the new test.

Run the job-search worker-surface integration file and the external-modules routes integration file through the repository's verify-gate procedure. This change is not user-facing; no live-path UAT is required beyond the gate.

## Process notes

Disclosed deviations from the authoring session, carried here so review can weigh them:

1. **`grill-with-docs` was not invoked.** The skill carries `disable-model-invocation` and instructs that the user run it themselves. A self-administered, codebase-grounded design interrogation was substituted, and the live cross-model adversarial pane was skipped because Fable review of this spec is already the downstream gate.
2. **codebase-memory graph tools were unavailable** in-session; grounding fell back to `Grep`/`Read` text search, per that skill's documented fallback.
3. **`node_modules` was not readable** (permission denied for both `Read` and `Bash`), so pg-boss internals were not inspected directly. The account of epoch-anchored `singleton_on` bucketing rests on the corroborating comment at `packages/jobs/src/pg-boss.ts:251-256` plus known pg-boss behaviour — it is the single largest inferential step in this spec and the pre-build grounding gate requires confirming it before the fix is chosen.
