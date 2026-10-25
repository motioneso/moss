# Meeting summary compatibility after a Claude CLI update

Bug follow-up for #3565 under the approved
`docs/superpowers/specs/2026-10-22-meeting-default-provider.md`. Mirrors the Codex fix in #3608.

A real ring recording reaches its Meeting and transcript, but automatic summary and every manual
Rewrite report `meeting_output_route_unavailable`. The selected default (Anthropic) is valid. The
installed Claude CLI is 2.1.286, while the constrained transport admits only 2.1.282, so the probe
returns `not_installed`. The managed updater correctly keeps a promoted release above the image
floor.

## Seams and decision

- `packages/chat/src/live/constrained-claude-profile.ts` resolves the installed package by its
  metadata version (advisory readiness) and checks the native SHA-256 again at launch.
- `tests/unit/constrained-claude-catalog-pin.test.ts` ties `CONSTRAINED_CLAUDE_VERSION` to the
  runner recipe, so that constant stays the image floor.
- `packages/chat/src/live/constrained-claude-profile.test.ts` runs the actual native executable
  against loopback inference with tool, hook, persistence and cancellation controls.
- `packages/meetings/src/manifest.ts` states no Claude version, so it needs no change.

Replace the single hash table with a releases allowlist keyed by version, keeping 2.1.282 and
adding 2.1.286. Readiness and launch use the same allowlist. Provider, model, default and
transcription settings are unchanged. Unknown versions and modified binaries fail closed; future
updates are not accepted automatically. Prototype-key versions (`constructor`) are rejected.

## Verification and stop condition

1. Verify the npm SHA-512 of both 2.1.286 platform archives before hashing the executables.
2. Run the existing native profile controls against 2.1.286: rejected before the change (exit 1),
   accepted after (exit 0). Also run the 2.1.282 floor. ARM hashes are verified without execution.
3. Focused unit tests and `pnpm verify:static` unpiped. Remove the hash guard, observe the
   regression fail, restore.
4. Independent Standards and Spec reviews on a different model. Live proof through the real
   Meeting UI on an isolated instance, no intercepted responses. Exact-head CI before merge.
5. After a reviewed image is deployed through the established backup and configuration-preservation
   procedure, Rewrite the retained production Meeting and confirm a saved summary.

Stop and report if 2.1.286 sends tools, reads project instructions in the protected profile or
persists a session. Never relax a protection to obtain a summary.

## Out of scope

Every future Claude auto-update repeats this. A lasting fix (hold the managed update to allowlisted
versions, or show the mismatch on the AI providers screen) is tracked in its own issue.
