# Tool updates respect the Meeting runner's approved builds

Issue #3689. Follow-up to #3565 (PRs #3608 and #3690). Builds on
`2026-09-25-cli-tools-auto-update.md`.

## 1. Problem

The tool-update system moves Claude and Codex to newer vetted versions on its own. The constrained
runner that writes Meeting summaries accepts only builds listed in its approved-build table
(`CONSTRAINED_CLAUDE_RELEASES`, `CONSTRAINED_CODEX_RELEASES`). When an update lands a build that is
not in the table, readiness reports "not installed" and every Meeting summary fails with
`meeting_output_route_unavailable`. This happened with Claude 2.1.286 and, earlier, with Codex.
Each time a person found it from a failed recording and added the build by hand.

Neither check in the update system looks at that table:

- The publisher's offline contract check (spec 5.1) tests install, flags and handshakes.
- The instance live check (spec 5.2) tests a chat turn and a structured call through the normal
  engines, not the constrained runner.

## 2. Decisions

1. **The publisher blocks a build the runner would reject.** In `prepare.ts`, after the package is
   installed and verified, hash the native executable for each architecture and compare it with the
   approved-build table from the current `main`. A build that is missing or has a different hash is
   `blocked`. The existing blocked path keeps the previous version in the manifest and files an
   issue, so a person is prompted to run the native proof and add the build.
2. **Each instance rejects a candidate its own image cannot run.** An older image can receive a
   manifest newer than its table. Before the live check, the instance staging step looks up the
   candidate's version and hash with the same function the runner uses at launch. A miss rejects
   the candidate with a named reason, keeps `current` on the old toolset and raises the existing
   admin alert (spec section 7). It makes no model call.
3. **One function decides.** Publisher, instance gate and runner all call the same exported
   `isSupportedConstrainedBuild(provider, version, arch, sha256)`. The table stays the only list.
4. **The table is still edited by a person.** Adding a build needs the native profile controls
   (no tools, no project instructions, no saved session), as in #3690. Nothing admits a build
   automatically.
5. **No new screen.** Rejections reuse the existing admin alert and the AI providers status text.
   Wording is updated and the app map entry changes in the same PR.

## 3. Tradeoff

Claude and Codex updates now wait for a Moss release that lists the build. Chat keeps working on the
old version meanwhile. A model that needs a newer CLI waits too. The alternative, letting chat
update while Meetings stay on an older copy, needs two installed copies per provider and is out of
scope.

## 4. Out of scope

- Admitting builds automatically.
- Changing provider, model, default or transcription settings.
- Gemini and other providers (no constrained runner).

## 5. Verification

- Unit: publisher blocks an unlisted version and a listed version with a wrong hash, passes a
  listed one. Instance staging rejects the same cases without a model call.
- Mutation: remove the check in each place and watch its test fail.
- Live: on a disposable instance with a manifest naming an unlisted Claude build, the candidate is
  rejected, the old version stays current and Meeting summaries still work.
