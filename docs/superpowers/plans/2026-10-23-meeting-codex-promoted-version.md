# Meeting summary compatibility after a CLI update

Bug follow-up for #3565 under the approved
`docs/superpowers/specs/2026-10-22-meeting-default-provider.md`.

A real ring recording reaches its Meeting and transcript, but automatic summary reports
`meeting_output_route_unavailable`. The selected default is valid. The constrained Codex probe
returns `not_installed` because it accepts only version 0.157.1, while the managed installer
correctly preserves an already-promoted 0.159.3 release.

## Seams and decision

- `packages/chat/src/live/constrained-codex-profile.ts:25` resolves native artifacts and checks
  their SHA-256; profile preparation checks again before execution.
- `packages/cli-runner/src/install-service.ts:710` preserves a promoted newer release rather
  than silently replacing it with the image floor.
- `packages/chat/src/live/constrained-codex-profile.test.ts:80` exercises actual pinned native
  executables against loopback Responses, including tool, instruction and persistence controls.
- `packages/meetings/src/manifest.ts:648` describes summary availability and remediation.

Add explicit, integrity-verified 0.159.3 platform artifact hashes to the constrained transport's
allowlist while retaining 0.157.1. Both readiness and launch use the same allowlist. Keep the
managed image floor and selected provider/model unchanged. Unknown or modified binaries still
fail closed. Do not accept every managed update automatically: each accepted version must pass
the existing native profile controls. A downgrade would restore the old artifact but also alter
the shared chat runtime and would not repair compatibility with the installed update.

## Verification and stop condition

1. Fetch both platform packages and verify npm archive integrity before recording binary hashes.
2. Reproduce rejection of the installed 0.159.3 native artifact with the existing loopback test
   (exit 1), then rerun after the allowlist change (exit 0). Exercise both supported versions on
   the host architecture; disclose that the other architecture's hash is verified without native
   execution. Add resolver regression coverage for managed npm layout and unapproved bytes.
3. Run focused unit tests and `pnpm verify:static` unpiped (expected exit 0). Observe a removed
   hash guard fail its regression, then restore and rerun.
4. Independently review Standards and Spec against the committed change. Exercise the actual
   Meeting UI on an isolated instance and record evidence before merge. No intercepted Moss
   responses. Run exact-head CI before merge.
5. After a reviewed image is published and deployed through the established backup/config
   preservation procedure, retry the retained production Meeting and verify a saved artifact.

The owner stops this line if 0.159.3 sends unexpected tools, reads project instructions in the
protected profile, or persists rollouts. Do not relax these protections to obtain a summary.

All availability/status feedback remains derived from records. The model's existing jobs remain
extracting grounded summary content and structured suggestions; no new model task or prompt is
introduced. The earlier failed automatic-summary receipt remains distinct from a manual retry.
