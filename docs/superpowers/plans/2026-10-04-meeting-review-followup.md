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

- Applied migrations 0263/0264 stay append-only; no squash or hash change.
- Private vault write/index receipt orchestration currently serializes filesystem work with the meeting receipt lock. This remains a bounded create-only export design, not an exactly-once filesystem claim or an Indexed result.
- History's artifact budget does not claim to bound all candidate data; the separate candidate count/storage bounds remain. Exact older versions remain accessible by owner-scoped version reads.
- History navigation/filtering, typography, switch/radio labels, step numbering, mobile/desktop layout and dark-theme readability require current UI assertions; source checks alone are insufficient visual proof.
- Live provider compatibility, native macOS/Windows capture, permissions, Teams/Zoom behavior and validated speaker separation remain unverified. No real credentials or workplace audio are used in these checks.
- DB checks run only in disposable job-isolated CI servers. Local DB gates remain withheld until the supported per-server wrapper for #2989 lands.
- Exported independent copies and accepted Tasks intentionally survive meeting deletion. No destructive retention change is introduced by this review.

Do not mark the PR merge-ready on the basis of this document. Record exact final commit, full CI, real UI results and any remaining findings in the PR after verification.

## Local verification checkpoint

Final review-fix tree: 546 focused tests across 42 suites passed. Root, test, web and external-module TypeScript checks, full ESLint and Prettier, static audits/app map, and web production build passed. A separate wider local unit run had five existing UAT provisioner tests blocked by this environment's network-interface restriction; they were not waived or counted as passing and remain in normal CI.

The expanded credential-free CI configuration runs 16 specs in four isolated groups. It records four existing fixmes as skipped and excludes four real-provider/login-gated suites; those remain release-proof requirements. No real credential is created, loaded or transmitted for these fixture groups; synthetic fixture values are used. Corrected viewport/theme/focus and export-owner assertions await actual execution after publication.
