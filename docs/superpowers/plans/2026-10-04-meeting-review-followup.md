# Meeting companion review follow-up (#2981)

Review source: [PR #2982 comment #5976578877](https://github.com/motioneso/moss/pull/2982#issuecomment-5976578877), pinned to a86c3e7. This checklist distinguishes published fixes, current work, and remaining proof. Native capture expansion is paused while this review is addressed.

## Published corrections

- A / B: undeclared export read route and JSONB candidate encoding fixed in 48cbf2e. Actual route-registration and query-parameter regressions added; output and export DB suites subsequently passed.
- Major 1: expected migration catalog extended through 0266 in b2da7fd. Major 2: Meetings depends on an injected private-copy port rather than Notes since 48cbf2e; feature-boundary guard unchanged.
- Output UAT's hidden native checkbox click corrected to the visible associated control in 44d981e, included in b2da7fd.

## Follow-up implementation, awaiting aggregate verification

- Major 3: preserve mounted Review/editor state while queries refresh, with deterministic query completion tests.
- Major 4: generic boolean-only session dirty markers and explicit sign-out confirmation; cancel keeps edits and the session. Markers survive navigation and clear with the authenticated cache.
- Majors 5–7: approved tabbed Review, plain review heading, responsive layout, capture choices, associated controls, readable copy and SPA navigation. Compare against committed mockups and verify actual browser flows before claiming visual fidelity.
- Major 8: prepare exact-model chat HTTP in a short transaction, run outside transactions with user cancellation and 120-second deadline. Tests first failed on held transactions/missing deadline; guarded one-shot and revoked-provider negative controls recorded.
- Major 9: one live generation reservation per meeting under owner row lock, including distinct request keys. Same-key replay remains stable; late/manual versions remain protected.
- Output minors: no sibling-as-prior-candidate warning; request JSON equality ignores object key order; history snapshots have a 2 MiB artifact budget and disclose omissions; read paths use shared rather than exclusive locks; 110-second provider deadline leaves margin before the existing 120-second reservation expiry.
- Exact hard model pins fail closed rather than substituting another model within the same provider. Provider-only pins and legacy callers keep existing behavior.
- Transcript evidence rejects UTF-16 surrogate-splitting ranges; oversized individual segments report the documented limit error.
- Referenced-evidence, unsaved sign-out and unavailable chat states are declared in the app map. Unavailable chat explains how to close and select an accessible meeting.
- Timing-sensitive 15 ms citation assertions replaced with condition-based waits. The full CI reproduced this timing failure on b2da7fd.
- Lifecycle schema test includes the five added output/export tables without weakening actual cascade-chain checks. The previous run passed the chain check and failed only its expected table list.
- Synthetic vault evidence helper executes as the existing non-root vault-owner UID/GID, as established by repository UAT practice. No filesystem permissions/capabilities are changed. Corrected runtime access still requires a passing UI rerun.

## Claims requiring qualification

- A transcript revision arriving during an answer does not by itself invalidate retained older citations: dereference checks the stored exact revision through the public evidence API, rather than requiring the current revision. Existing real UI proof opened an older revision beside the current transcript. Availability still fails closed when the cited revision is missing or access is lost.
- A create replay racing deletion can report an unavailable result; no claim of successful creation should be made when the record was concurrently deleted. Review this separately if a reproducible route test exposes a500.

## Preserved decisions and remaining proof

- Earlier “applied migrations 0263/0264” wording referred to disposable CI runs. The unmerged sequence is now 0273–0280, with cleanup/immutability at 0276/0277; their SQL bytes are unchanged. Applied main migrations remain untouched. See the [migration note](../../../packages/meetings/README.md#migration-numbering); historical checks do not verify this new numbering.
- Private vault write/index receipt orchestration currently serializes filesystem work with the meeting receipt lock. This remains a bounded create-only export design, not an exactly-once filesystem claim or an Indexed result.
- History's artifact budget does not claim to bound all candidate data; the separate candidate count/storage bounds remain. Exact older versions remain accessible by owner-scoped version reads.
- History navigation/filtering, typography, switch/radio labels, step numbering, mobile/desktop layout and dark-theme readability require current UI assertions; source checks alone are insufficient visual proof.
- Live provider compatibility, native macOS/Windows capture, permissions, Teams/Zoom behavior and validated speaker separation remain unverified. No real credentials or workplace audio are used in these checks.
- DB checks require disposable servers. The merged `scripts/run-gate.sh` now supplies a per-run server; follow `verify-gate`, never direct DB commands. This source-only review did not run a local DB gate; new exact-commit CI and UI proof remain required.
- Exported independent copies and accepted Tasks intentionally survive meeting deletion. No destructive retention change is introduced by this review.

Do not mark the PR merge-ready on the basis of this document. Record exact final commit, full CI, real UI results and any remaining findings in the PR after verification.

## Local verification checkpoint

Final review-fix tree: 546 focused tests across 42 suites passed. Root, test, web and external-module TypeScript checks, full ESLint and Prettier, static audits/app map, and web production build passed. A separate wider local unit run had five existing UAT provisioner tests blocked by this environment's network-interface restriction; they were not waived or counted as passing and remain in normal CI.

The expanded credential-free CI configuration runs 16 specs in four isolated groups. It records four existing fixmes as skipped and excludes four real-provider/login-gated suites; those remain release-proof requirements. No real credential is created, loaded or transmitted for these fixture groups; synthetic fixture values are used. Corrected viewport/theme/focus and export-owner assertions await actual execution after publication.

## Subsequent review: encoded routes and actionable summary failures

The independent review of `69150727` found a reproducible encoded-path bypass: raw URL prefix
checks could miss a Fastify-decoded chat route and allow a reserved meeting surface into the
general engine. This supersedes the earlier source-level claim that the hook alone proves the
boundary. The narrow repair must use matched-route identity and independently reject meeting
selection at general turn/stream/seed/switch entry points. Regression proof must exercise encoded
URLs through the real router and observe failures with each protection removed. Final results
must be tied to the repaired commit; the earlier green tests did not cover this case.

The summary UI must retain allowlisted capability errors instead of replacing an unsupported
CLI-only configuration with generic retry advice. Admins can follow the existing AI providers
link; other users need a clear explanation and administrator-directed recovery. Provider/model
pins and the API-key-only checkpoint remain unchanged, without raw provider errors or secrets
returned to the browser.

### Proposed release note

Category: Added
Title: Meeting drafts and notes
Description: Create meeting drafts, save personal notes and find them in History; recording is not available yet.

This is the wording to use in the PR's authoritative Release note section once its description
update is approved. Keeping it here does not update that section. The README now distinguishes
ordinary UI access and notes-grounded outputs from transcript review/Ask Moss, which require
API-supplied transcript text. Notes-only summaries are supported with a suitable API-key model;
the review’s broader statement that all output flows require a transcript is not supported by
the UI and service code.

### Remaining publication and provider proof

The final repaired commit still needs exact-head CI, native compile/synthetic tests and real-UI
acceptance, plus the required live-proof PR comment. Real-provider Sports, note retrieval, note
path-boundary and Workshop chat-handover gates remain separate and unrun here. They are not
waived by credential-free tests. The owner must control authentication material for any local
real-provider gate; no real credential or audio activation belongs in this repair.

### Local repair evidence

Restored source passed 662 focused tests across 48 suites, root/test/web/external-module
TypeScript, full lint/format/static checks and the web production build. Independent removal
of matched-route dispatch produced four failing regressions; removal of matched-route response
authorization produced three; removal of only general-handler rejection produced 41. The
summary UI regressions failed before the repair, and a raw-provider-error mutation failed its
redaction assertion. Restored focused suites passed.

The existing chat and output UAT cases now include six encoded-route rejection requests and
real capability-failure recovery through the Moss API. Neither was run locally in this cloud
workspace; exact published-commit CI and UAT results belong in the PR proof, not in these local
test counts. No live provider authentication, database mutation or capture was performed here.

## Owner-run real-provider follow-up and main reconciliation

The owner-run [result on `10cee6f8`](https://github.com/motioneso/moss/pull/2982#issuecomment-5984601520)
reported three executed real-provider passes (Sports and both Notes cases), zero skips, a failing
Workshop case and successful disposable-stack cleanup. This is not a four-spec pass. Workshop
saved and opened the project, then awaited the removed `No plan yet` label. Source and the
`b396d1021` removal confirm [#3035](https://github.com/motioneso/moss/issues/3035): the current
screen is a named Project conversation region, not a Plan heading. The repaired assertion checks
that region, its project composer and the saved request there, retaining the real-model save,
exact project link and project-list checks. It does not fake responses or relax provider gating.

Reconcile main `8ce21ae` without editing any migration: Meetings keeps 0273–0280 and main keeps
0281–0282. Preserve both Backtrack and Meetings registration, their complete expected migration
order, and both shared RowIndex options (Meeting facts and main's compact rows). Regenerate the
UI catalogue and cover the option combinations. New CI, macOS and assembled-UI evidence must
use the reconciled head; prior results do not establish this tree's behavior.

A clean owner-controlled four-spec real-provider rerun remains required. The report names Claude
Opus 5.5 (Anthropic); the builder is OpenAI. That reported identity does not independently verify
the reviewer's upstream proxy or supply a current detailed security re-review. Do not claim
verified cross-provider approval, real capture readiness or merge clearance from this report.

The first reconciled run at `337127e0` passed the Meetings UI group and macOS tests but exposed
another stale regression assertion: `moss-assistant-name` still required the fixed Moss wordmark
although main #3032 intentionally personalized that chrome. Reconcile this test with the current
persona-name contract rather than reverting the approved product behavior. Keep the provider-free
UI check, preference persistence and restoration, and make the regression group's bounded failure
output retain locator/expected/received and source-line diagnostics. This failed run is not passing
proof of the repaired test; the next head must rerun the full checks.
