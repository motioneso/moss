# Build Plan — News AI Ranking Failure Recovery (#1585)

Status: approved by Coordinator

## Scope and diagnosis

This is the approved issue-driven bug lane described by the build handoff; no new feature spec or
migration is needed. The current path is:

`GET /api/news/overview` (`packages/news/src/routes.ts:111-124`) → `NewsService.getOverview`
(`packages/news/src/news-service.ts:120-145`) → `triggerNewsRefresh` → `enqueueNewsRefresh`
(`packages/news/src/jobs.ts:70-78`) → `registerNewsJobWorkers`
(`packages/news/src/jobs.ts:92-202`) → `compilePersonalizedNews`
(`packages/news/src/compilation/compile.ts:50-148`) → `rankCandidates`
(`packages/news/src/compilation/rank.ts:77-127`) → `NewsAiPort.generateJson`
(`packages/news/src/discovery/ports.ts:63-78`) → `module.news` structured routing
(`packages/module-registry/src/index.ts:665-683`).

`generateStructured` already classifies provider/gateway and output failures separately
(`packages/ai/src/structured/generate-structured.ts:80-221`): `provider_error`, `needs_config`,
`validation_failed`, and `aborted`. `rankCandidates` currently collapses all unsuccessful results
to `{ ok: false }`, and `compilePersonalizedNews` returns `kept_last_good` with `failureKind: "ai"`
(`compile.ts:106-114`). The worker then records failure instead of publishing the successfully
fetched candidates (`jobs.ts:119-141`). This matches the production `failure_kind='ai'` and stale
snapshot evidence in the handoff; the existing tests deterministically reproduce both provider
failure and malformed-output branches (`tests/unit/news-rank.test.ts:56-76`,
`tests/unit/news-compile.test.ts:119-130`).

## Decision

When collection and deterministic filtering succeed but AI ranking fails, publish the filtered
candidate set in deterministic recency/preference order with a neutral relevance score. Keep the
AI failure visible through a bounded structured warning containing only the failure category and
candidate count. This makes the snapshot fresh and keeps the user-facing surface usable while
repeated provider or validation failures remain observable; no provider, model, retry policy,
secret, expiry, or database behavior changes.

The ranking boundary will preserve the AI error category so the warning distinguishes gateway/
provider/configuration failures from malformed/schema output. Unknown or invalid generated objects
remain a ranking failure and use the explicit `malformed_output` category.

## Phase 1 — implement and verify the recovery path

1. `packages/news/src/compilation/rank.ts`

   Extend the `rankCandidates` failure return contract with the existing structured-AI error
   categories plus `malformed_output`. Return `generated.error` for `{ ok: false }` and
   `malformed_output` when `{ ok: true }` cannot be parsed as the required rankings object. Keep
   prompt construction, schema validation, ID filtering, and normal ordering unchanged.

2. `packages/news/src/compilation/compile.ts`

   Extend `MetadataLogger` and `NewsCompilationLogFields` with an optional warning seam for a
   `news_compile_ai_fallback` event carrying `aiError` and `candidateCount`. When ranking returns
   a failure, emit that warning and construct deterministic ranked candidates from the already
   filtered candidates; otherwise use the AI-ranked candidates. Publish the resulting payload
   through the existing `publishSnapshotIfCurrent` CAS, so successful collection always refreshes
   the snapshot. Preserve the existing fetch-failure and internal-exception last-good behavior.

3. `packages/module-registry/src/index.ts`

   Wire the worker compilation logger's warning method to the host logger with the existing
   `news compilation` message context. No secrets, prompts, URLs, or model/provider identifiers
   cross this log seam.

4. Tests
   - `tests/unit/news-rank.test.ts`: assert provider/configuration errors and malformed output
     retain distinct failure categories.
   - `tests/unit/news-compile.test.ts`: replace the old AI-last-good expectation with the focused
     regression: a successful fetch plus AI provider failure returns `replaced`, publishes the
     current candidates, and emits the bounded fallback warning. The test fails against the
     current implementation because it returns `kept_last_good` and publishes nothing.
   - `tests/integration/news-refresh-jobs.test.ts`: update the existing AI failure job assertion to
     prove the worker completes the refresh and replaces the old snapshot while keeping the
     failure category in the worker warning evidence.

5. Live path

   Run the existing user-facing News UAT `tests/uat/specs/1185-news-layout.uat.spec.ts`; its
   trigger is already registered for `packages/news/**` in
   `.claude/skills/coordinate/uat-trigger-map.tsv:36-37`. Record the run exit code and bounded
   DOM/network evidence in the PR. If no live dev instance or usable AI binding is available,
   report `code-complete, unverified` with the exact blocker.

## Verification

Expected exit code 0 for each command:

```bash
pnpm vitest run tests/unit/news-rank.test.ts tests/unit/news-compile.test.ts
pnpm vitest run tests/integration/news-refresh-jobs.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
```

Before push, run the full isolated gate through `scripts/run-gate.sh` as required by
`coordinated-wrap-up`; never use a live development database.

## Kill gate

After Phase 1's unit/integration checks, stop and escalate to the Coordinator if deterministic
fallback candidates cannot pass the existing snapshot validator, if the live UAT shows stale or
empty news after a successful fetch, or if the warning would require logging provider identity,
prompt content, URLs, or secrets. The Coordinator owns any resulting product/security fork.
