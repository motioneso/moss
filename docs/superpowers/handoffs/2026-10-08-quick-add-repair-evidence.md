# Quick-add repair evidence

The Tasks quick-add form could accept another submission before its pending state rendered. It now reserves submission synchronously and releases after the mutation settles, including the awaited task refresh. The existing failure draft and edits made while saving are preserved. The Tasks module app map describes quick capture, errors, and list/correction/retry recovery.

## Reproduction and unchanged original test

Base: `7a2efc3f3b9d5d60d0856538ea21d52b979e863a`.

The original CI test, “quick add sends one request while saving and keeps the draft when it fails,” passed once locally at that base. Its exact historical CI timing was not reproduced locally; no preexisting/flaky classification or current CI readiness is claimed. The original test block is byte-identical to the base, SHA-256 `4e846bb5e7eaf7a4ef4b905d48823fdc0e3c486cfd403ff3dd7f5bc68c0aec8f`.

A new deterministic browser check submits the native form twice in one browser turn while holding its POST at the approved browser/API fixture seam. Before the product edit, it failed `Expected: 1, Received: 2`. After the synchronous reservation, it passed, including a deliberate retry after failure. The automated fixture's held mocked response is distinct from the real installed proof below. No skips, arbitrary waits, original assertion weakening, or production test controls were added.

## Source and independent review

Final reviewed clean source/harness pin: `a9d9bff7be534d3f5c14ee82558ef72e78abf898`. Product runtime files remain unchanged from `416bfdadad1cb69c3fecf21156e23102c11e49d5`. The two later commits change only the UAT harness: send its required DELETE object and reuse canonical `signInUatAdmin`.

Independent Standards and Spec reviews are GREEN at the final pin. The Standards finding about copied sign-in logic was corrected; the Spec review independently verified original-test integrity, settlement after awaited invalidation, draft/retry behavior, app-map coverage, and the genuine installed proof.

## Frozen checks

The first clean-pin gate completed with exit 1: full static, 62 unit/harness checks, and 72 Tasks API checks passed, then the Tasks browser suite reported 29 passed and one original list-filters test timed out. Its bounded DOM snapshot contained only “Loading Moss,” before Tasks mounted. An instrumented rerun of that exact unchanged test passed in 2.0s, with bootstrap/me and Tasks query responses all 200 and no page errors or failed requests. The original startup hang remains unexplained; no preexisting/flaky/capacity classification is made. The fresh identical full gate then completed with terminal exit 0 at the same clean source pin and fingerprint `sha256:92a8a1cdbfd6ca913884725eface7164edd58a5f6f954f44af34580efea61101`. Its receipt is `jarv1s_scheduled_quick_add_fix-20261008-230530.log`, completed 2026-10-08 23:11:49 America/Los_Angeles. The isolated pgvector PostgreSQL 17.11 container was removed. Toolchain: Node 22.22.2 and pnpm 10.6.2.

| Check | Final result |
| --- | --- |
| Full static, with `GITHUB_HEAD_REF=integration/scheduled-proactive` | Passed, including lint/format, repository rules, root/tests/web/external types and app-map generation |
| Seven exact unit/harness suites below | 62 passed |
| Three exact Tasks API suites below | 72 passed |
| Entire Tasks Chromium browser suite | 30 passed in 56.7s |

The archived private checker invoked these suites. The exact private browser command is archived alongside its hashed claimed-port config; its local path is omitted here:

```text
GITHUB_HEAD_REF=integration/scheduled-proactive pnpm verify:static
env -u JARVIS_UAT_CLAIMED_WEB_PORT pnpm exec vitest run tests/uat/run-uat.test.ts tests/uat/provisioner.test.ts tests/unit/web-task-view-model.test.ts tests/unit/web-task-details-model.test.ts tests/unit/tasks-contract-tags.test.ts tests/unit/app-map-integrity.test.ts tests/unit/app-map-build.test.ts
pnpm exec tsx scripts/test-integration.ts tests/integration/tasks.test.ts tests/integration/tasks-web-contract.test.ts tests/integration/tasks-verticals.test.ts
pnpm exec playwright test --config <archived claimed-port config> tasks.spec.ts
```

Private ignored runner bytes were archived separately from the Git fingerprint: SHA-256 `993b1e7effb79675882f7da1b28469679c52f48c7352f84fee65e11a863f6f63`; original claimed-port Chromium config SHA-256 `cc186c3b05788074ce92d1e91fa7c568285e1d5143c6b5c16999ddfd599e57c6`. The config uses one worker, port 5182, and capture off. The two exact gate receipts have identical clean source fingerprints and helper/config bytes; the earlier failed result is retained, not reclassified as a pass.

This receipt certifies the recorded clean source pin. A later evidence-only commit changes this document and gets its own static check; no earlier receipt is represented as testing a different commit.

## Installed real UI/API proof

The first UAT invocation rebuilt the standard repository Dockerfile at runtime source `416bfdada`, producing image `ghcr.io/motioneso/moss:uat-quick-add-416bfdada` with ID `sha256:88a4168ca87acb6ea2031d45f879494bef054f26254ca82f8012d3bd1b4b4e12`. The earlier derivative image was replaced and was not used for the installed proof. Installed TaskCapture and Tasks manifest source digests match the frozen checkout. The final run reused that exact image with the repaired final harness:

```text
MOSS_UAT_BUILD=0 JARVIS_UAT_CLAIMED_WEB_PORT=5182 \
JARVIS_IMAGE_TAG=uat-quick-add-416bfdada MOSS_UAT_CAPTURE_OFF=1 \
pnpm test:uat quick-add-admission.uat.spec.ts

1 passed (3.0s test; 5.3s Playwright total); harness terminal exit 0
```

The disposable project was `uat-268795_81c95414`; the provisioner removed its containers, network, and volumes after the run. The proof signs in through the actual UI, visits Tasks, and makes real API calls. Removing an empty focused list through the API causes a genuine stale-list 404; the displayed error keeps the draft. Selecting All lists and pausing only that disposable app holds its real unaltered request. Two native form submissions plus repeated Enter while pending admit one request. Unpausing recovers, persists exactly one task, and preserves text typed for the next task. A deliberate next save persists exactly one more task, clears the field, and both tasks remain visible after reload.

Recorded executable assertions:

```text
ASSERT genuine API 404 retains the quick-add draft; no response interception
ASSERT real paused-app pending request admits once, including repeated Enter
ASSERT recovery persists one task, preserves the next draft, and permits its deliberate save
```

The first attempt failed in harness setup before quick capture because DELETE omitted its required object and returned 400. Adding `{ data: {} }` fixed the setup; no product cause was inferred from that failure. The final installed run intercepts or rewrites no Moss responses and captures no screenshots.

## Limits and cleanup

The reservation applies to one mounted quick-capture form. It does not provide server-wide idempotency across clients or uncertain network retries. No worker scheduling change, full foundation result, branch-wide GitHub CI readiness, PR readiness, production merge, or deployment is certified. Owned live resources were removed and the claimed port was released at closeout; a stopped image reservation is retained for the coordinator's integration audit.
