# #3125 Main reopen/next-turn repair evidence

This supplement records the repair of the Main reopen/next-turn race found by the original
classifier-shadow installed scenario. Preserve the earlier [#3125 evidence](2026-10-08-3125-evidence.md):
its prior live run passed its scenarios, but did not establish this later overlapping-resume path.

## Reviewed source and scope

Clean source and executable-harness pin: `01a014e1c3e81e207eea15f4a991f675ce8656a7`.
Integration fixed point: `fbd692f0d188269ad4814c8e11e21fac7bbfd7db`.
Source tree: `e1c2c747f983b9454824b690e8259a1c492ff7a2`.
Branch: `scheduled/main-reopen-repair`, checkout `~/Jarv1s-scheduled-main-repair`.
Independent Standards and Spec source reviews both passed this exact pin.

Public turn admission and shared engine ensures wait for selection transitions. The composer and
queue wait for Main resume and history readiness. Explicit New/private selection supersedes startup
hydration; forced replay is recomputed after transition completion. Cancellation releases each
waiting turn without canceling shared warmup. Verified-unavailable healing follows the same caller
cancellation rule; unrelated persistence errors propagate unchanged. Existing ownership and
uncertain-action non-replay behavior remains covered. The chat module app-map feature is updated;
fixtures follow the owner-Main lookup and schema catalogue.

## Current clean-pin receipts

Gate input fingerprint: `57679377015c97986c714fdd13babf8733c9b12eddfb786b6f81ba089a4c7c5d`.
Host Node 22.22.2, pnpm 10.6.2; disposable pgvector PostgreSQL 17.11.
Every DB-touching run used `scripts/run-gate.sh` and sentinel `wait --follow`, with actual terminal
exit codes. No existing user's database was touched.

| Check                                                           | Result          | Receipt basename                                   |
| --------------------------------------------------------------- | --------------- | -------------------------------------------------- |
| Full static, all typechecks and app-map generation              | exit 0          | `jarv1s_scheduled_main_repair-20261008-165255.log` |
| Scoped lifecycle/binding/owner/hydration units, 11 actual files | 258/258, exit 0 | `01a014e1c3-final-units.log`                       |
| Six existing Main/chat integration suites and current app map   | 184/184, exit 0 | `jarv1s_scheduled_main_repair-20261008-165727.log` |
| Serial Chromium hydration/drawer regressions                    | 11/11, exit 0   | `01a014e1c3-browser-regressions.log`               |

Static used `GITHUB_HEAD_REF=integration/scheduled-proactive`. Scoped DB ran the committed
`test:main-chat-regressions` entry. Browser mocks are regression checks; their external Playwright
config selected the existing `main-chat-hydration.spec.ts` and `chat-drawer.spec.ts`, workers 1,
claimed devport 5189, capture off. Server/browser teardown completed and port was released.

The unit command was `pnpm exec vitest run` with:

```text
tests/unit/chat-session-thread-binding.test.ts
tests/unit/chat-session-manager-resume.test.ts
tests/unit/chat-session-manager-stopturn.test.ts
tests/unit/chat-session-manager-provider-identity.test.ts
tests/unit/chat-session-manager-private.test.ts
packages/chat/src/live/chat-session-newchat-stop.test.ts
tests/unit/chat-origin-record-routing.test.ts
tests/unit/chat-action-hydration.test.tsx
tests/unit/conversation-provenance-store.test.ts
tests/unit/chat-classifier-gate.test.ts
tests/unit/chat-thread-selection-lock.test.ts
```

Meaningful observed reds preceded the repair: next submit reached the retiring engine during held
kill; pending Main resume did not block composer; Stop left turns waiting on a late provider check,
shared prestart or replacement healing; an unrelated save error was converted to stopped success.
Restored tests assert cancellation and lock admission before deferred work releases, no canceled
submit/save/retry, surviving shared warmup, and exact unrelated error identity. The earlier full
static run at `14defc9763` failed on the drawer source-size check; the current guard reuse fixed it
without changing conditions. Earlier dirty receipts and that failed static run are not reused.

## Rebuilt runtime pin

Image: `ghcr.io/motioneso/moss:uat-main-reopen-01a014e1c3`.
Image ID: `sha256:b85a59c14ce59d0a7e45cc163b2c0a1c162d4395347a301eb9bf6d71285b2013`.
Runtime is production, Node 24.21.0; embedded commit metadata matches the reviewed clean pin.

The validated dependency base's installed lock and the checkout frozen lock match SHA-256
`894a5de8bb90dc67a5d492cbca9cbc59e183c3b4591df9ecbf42e6523dad2726`.
Workspace and npmrc hashes match. Root and all workspace manifest dependency fields match aggregate
`9e4242b21b49347f15b6e6444936b748451e480d35c215fb009e98b1507e83a6`.
The rebuild copied current source, removed inherited output, and rebuilt API, worker, web,
embedding/PDF/pattern workers, app map and Sports sidecar. All 2,459 runtime input files match
checkout/image aggregate `c452e7f24572a50635036d589f16cfecd1c1c4b150f03d19f700638d2a7563c7`.
Runtime artifact aggregate: `9ad2f71c7e5175ce2f64fdd470804e32e41a25c5894ab0b8a5d9957e1b6619d7`.
External Dockerfile SHA-256: `25152275e95d2f516cf74510e1862cd625c2216c7b506174825171a865af307d`.
Successful build receipt: `01a014e1c3-image-rebuild.log`, exit 0. An initial build inherited production
NODE_ENV during build-time app-map generation and failed; the build shell then matched the normal
Docker build-stage environment. Runtime NODE_ENV remains production.

## Original installed scripted regression

The committed `test:uat:classifier-shadow` entry ran the original
`tests/uat/specs/classifier-shadow.uat.spec.ts` against the rebuilt image: **1/1, exit 0**.
Receipt: `jarv1s_scheduled_main_repair-20261008-170607.log`; clean source pin/fingerprint above,
Compose project `uat-1371510_7c213201`, fresh claimed devport 5189, build disabled, capture off.
Gate ended 2026-10-08 17:07:38 America/Los_Angeles. Original spec and scripted-provider fixture
have no diff from the integration fixed point. All three ordinary UI turns returned 200 with their
unchanged expected rendered replies. The previously failing second turn after changing the
classifier to its unreachable fixture now passes. Existing shadow decision/match, failed-decline,
no approval card and gate-Off no-extra-record assertions remain intact. This is the original
scripted regression, separate from configured-model product proof.

Provisioner removed its stack, network and volumes; gate container was removed and port released.

## Configured-model live UI proof

The committed `test:uat:3125-real` entry ran
`tests/uat/specs/3125-main-chat-real.uat.spec.ts`: **1/1 full scenario, exit 0**.
Receipt: `jarv1s_scheduled_main_repair-20261008-170759.log`; exact clean source/harness
pin and fingerprint above, rebuilt image above, Compose project `uat-1390047_9bde25cd`, fresh claimed
devport 5189, `JARVIS_UAT_BUILD=0`, capture off. Gate ended 2026-10-08 17:09:40
America/Los_Angeles. The provisioner removed its stack, network and volumes; gate container was
removed and the port released.

The scenario requires a configured real model and cannot silently skip. Existing provider setup
and model discovery selected an active economy-tier chat model and bound it through ordinary
account override APIs. No chatScript, API/stream interception, rewritten reply, screenshot, video
or trace was used. Five synthetic prompts were submitted through the ordinary drawer composer;
each real turn response was nonempty and that exact reply was required to appear in the UI.

Bounded actual reply output, unchanged:

```text
[3125 real reply] "Main saved."
[3125 real reply] "Side saved."
[3125 real reply] "Warm Main"
[3125 real reply] "Cold Main."
[3125 real reply] "Private acknowledged."
1 passed (53.4s)
### FINAL rc=0
```

Assertions preserve the complete original scenario and strengthen warm reopen:

- Main and later side first turns persist separately with different IDs and Main flags.
- Reload with a warm side engine immediately submits through the reopened drawer. The observed
  public request/response order is exactly `resume`, then `turn`; Main history is visible, side
  history is absent, and the actual next continuation is stored on original Main, absent from side.
- The preserved side can be selected through History, then a real server restart and cold reopen
  restore original Main history and its next real continuation.
- Explicit private activation is confirmed by the public banner and privacy API before the first
  private turn. Its actual reply renders, its prompt is absent from every persistent thread's
  messages returned by History API, and reload restores original Main without private history.

The word "ephemeral" in the scenario's log refers to that persistent History API assertion. It
establishes no provider-filesystem retention guarantee. The original migration guard-negative
control is documented in the preserved earlier evidence, not rerun or claimed as new proof here.

## Limits and handoff

The current source pin has independent source reviews, fresh static/scoped unit/DB checks,
rebuilt artifacts, existing browser regression checks, original scripted regression and actual
configured-model UI proof. This report does not claim current GitHub CI green, a merged PR or a
production deployment. Integration remote was reconciled to the fixed point above before the
final documentation-only commit; that commit changes only this evidence supplement. The
source/runtime/harness certification pin remains `01a014e1c3e81e207eea15f4a991f675ce8656a7`.

Gate receipts remain outside the repo in `/tmp/jarv1s-gate`; image/unit/browser build records
remain outside it under `/tmp/moss-scheduled-implementation/main-repair`. Browser config digest:
`505693f269507b7ec1aa33d0bace8926de0f14a8275be6496855cbd7901ce7a4`.
The stopped/created runtime reservation `uat-main-repair-runtime-pin-01a014e1c` intentionally
retains the validated image for the integration owner; no test server or browser remains active.
All other owned ephemeral app resources and devport claims were cleaned. The parent coordinator
owns PR/tracking, integration, CI, merge and deployment decisions.
