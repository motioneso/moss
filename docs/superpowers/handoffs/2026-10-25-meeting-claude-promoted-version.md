# Meeting summaries fail after a managed Claude update

Bug follow-up for #3565 under the approved
`docs/superpowers/specs/2026-10-22-meeting-default-provider.md`. Ben approved the fix in chat on
2026-10-25 ("Yes, fix it"). The user has authorized reviewed merges.

## Diagnosis (verified 2026-10-25)

- A real ring recording reached its production Meeting and transcript. Automatic summary and
  every manual Rewrite fail.
- Production Settings → Admin / Setup → AI providers shows Anthropic as the instance default,
  installed **Anthropic CLI 2.1.286**.
- `packages/chat/src/live/constrained-claude-profile.ts` admits exactly one version,
  `CONSTRAINED_CLAUDE_VERSION = "2.1.282"`, with one SHA-256 per architecture.
  `findConstrainedClaudeExecutable` rejects 2.1.286, `probeConstrainedClaudeProvider` returns
  `not_installed`, `createConstrainedCliReadinessProbe` returns `model-unavailable`, and the
  Meeting runtime throws `meeting_output_route_unavailable` ("Your default model is unavailable
  or cannot produce structured summaries").
- The earlier `meeting_output_provider_failed` attempt ran on Codex (0.159.3, already allowed)
  while Codex was failing every production request with "Internal error" around 02:23-02:25 UTC.
  That was a transient vendor/runtime fault, not this bug. Do not change Codex.

## Precedent to follow exactly

PR #3608 (commit `f247daa24`) fixed the identical Codex case. Read its plan
`docs/superpowers/plans/2026-10-23-meeting-codex-promoted-version.md` and evidence
`docs/evidence/3565-meeting-codex/native-compatibility.md` in full. Mirror that shape for Claude:

- Convert the single Claude pin into an explicit releases allowlist keyed by version, keeping
  2.1.282 and adding 2.1.286. Readiness and profile launch must use the same allowlist.
- Get the hashes from the official `@anthropic-ai/claude-code-linux-x64` and `-arm64` npm
  archives at 2.1.286. Verify each archive's published SHA-512 integrity before extracting and
  hashing the native executable.
- Run the existing native profile controls in `constrained-claude-profile.test.ts` against the
  2.1.286 executable: observe it rejected before the change (exit 1), accepted after (exit 0).
  The protected profile must still send no tools, read no project instructions and persist
  nothing. Stop and report if 2.1.286 breaks any of those. Never relax a protection to get a
  summary.
- Do not auto-accept future versions. Unknown or modified binaries still fail closed.
- Keep the provider, model, default and transcription settings unchanged.
- Update the Meetings manifest feature text only if it states a version.

Out of scope, but worth noting in the PR: every future Claude auto-update will repeat this.
A lasting fix (pin the managed Claude update to allowlisted versions, or surface the mismatch on
the AI providers screen) needs its own issue. Open one and link it.

## Cycle

1. `pnpm install`. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`.
2. Commit a bounded plan with the repo `plan-build` skill
   (`docs/superpowers/plans/2026-10-25-meeting-claude-promoted-version.md`) and an evidence doc
   under `docs/evidence/3565-meeting-claude/`.
3. Implement, focused tests, `pnpm verify:static` unpiped. Observe a removed hash guard fail its
   regression, then restore.
4. Use `verify-gate` for any DB-touching command. Claim ports with `devports`.
5. Independent Standards and Spec reviews by a fresh session on a different model than the
   builder, against immutable base/head commits. Resolve every finding; get re-review.
6. Live proof on an isolated instance through the real Meeting UI. No intercepted responses.
   Record it on the PR. Run exact-head CI, fill the Release note section, merge with
   `gh pr merge --squash --auto`.
7. Production: after a reviewed image is published, deployment follows the established
   coordinated-backup and configuration-preservation procedure. Then Rewrite the retained
   production Meeting and confirm a saved summary appears. A merge alone is not a deploy.

## Boundaries

- No phone, ring or ADB access. Another session owns the device work.
- No production database reads or writes. Production checks go through the product's screens
  and the existing deploy procedure.
- This repository is public. Keep hostnames, addresses, credentials and private transcripts out
  of every committed file.
- Leave the worktree clean and stop owned servers when finished.

## Start

Begin at Cycle step 1 now.
