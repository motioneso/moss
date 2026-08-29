# Build plan: Sports story preference live verification (#2063)

Issue: https://github.com/motioneso/moss/issues/2063

## Scope

Use the merged Sports preference implementation as-is. Extend the existing multi-user UAT only
if needed to prove that removing the first user's Sports preference in Settings makes the removed
story eligible again. Do not change product code, News behavior, shared relevance rules, or seed
data.

## Current seams

- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts:130-169` already signs in, saves and
  removes the Sports preference, and verifies the Settings row disappears.
- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts:141-148` already proves the removed
  story stays hidden after a Sports reload while its preference exists.
- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts:171-177` already exercises the same
  save, replacement, and removal flow from Today.
- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts:179-217` already proves the second
  user cannot see or alter the first user's preference.

## Task 1: add the missing restored-eligibility assertion

After the existing Settings removal assertion, reload the Sports page and wait for the normal
Sports overview response. Assert that the original story reference is present again, and record a
plain-English live-proof message. This test would fail if the Settings removal deleted only the
visible row while the server still filtered the story.

Files:

- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts`

Verification:

- `pnpm test:uat tests/uat/specs/2051-sports-story-preferences.uat.spec.ts` — expected exit 0.
- Record the UAT exit code and bounded textual evidence from the real UI path on PR #2064; do not
  capture, attach, or review screenshots for this check.
- `gh pr checks 2064 --repo motioneso/moss` — expected all required checks green.

## Kill gate

Stop and record the lane as blocked if the live UAT cannot run against the development instance,
the original story does not become eligible after removal, or the required checks are not green.
The lane owner makes this call; no product workaround is in scope.

## Determinism boundary

No production UI or model behavior changes are planned. The assertion reads the server response and
the rendered story, so the test checks the recorded preference effect rather than model output.
