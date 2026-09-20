# Trail Marker session handoff

Date: 2026-09-20
Worktree: `~/Jarv1s/.claude/worktrees/jev-focus-arch`
Branch: `plan/jev-focus-pilot`
Implementation issue: [#2560](https://github.com/motioneso/moss/issues/2560), Backlog on project 2.

## Completed

- Wrote [Trail Marker foundation spec](../superpowers/specs/2026-09-20-trail-marker-mac-companion.md) from the product interview and supplied design.
- Committed the approved [design handoff](../specs/Trail%20Marker/trail-marker-design-guide/README.md), tokens, official logo and visual reference alongside the spec.
- Published the branch and created #2560 with scope, acceptance criteria and source links. The separate desktop-server packaging epic #2316 is related context, not this task's parent.
- Improved the standalone Jev pilot: saved-key loading, provider-specific authentication errors, 15-second testing interval, explicit discard reasons and a native notification/sound on focus flags.
- Delivered updated pilot scripts to the user's Mac via Taildrop.

## Verified pilot evidence

Offline command: `python3 -B -m unittest discover -s tools/jev-pilot -p 'test_*.py'` — 53 tests passed during wrap-up.

User-provided Mac terminal output verified:

- Local single-window preview and image deletion report.
- Live vision-to-Jev classifications after loading saved credentials.
- Three qualifying distracted samples accumulated 0, 15.4 and 30.8 seconds and triggered the configured 30-second focus flag.
- The next focused sample reset the timer to zero; five further focused samples kept it at zero.
- One invalid vision observation was skipped without stopping the run.
- The user explicitly confirmed both the notification banner and its sound.

This is controlled pilot evidence, not broad classification-accuracy validation or a production companion release. Full-repository gate and CI outcomes belong in the review PR; do not infer them from these tests.

## Agreed companion scope

Native menu-bar app named Trail Marker, macOS 14+, Intel and Apple silicon. Connect to an existing compatible Moss instance via browser approval; remote HTTPS, local-loopback HTTP allowed. One linked account per process, multiple independently revocable Macs per account. Restricted identity/own-device credential in Keychain. Persistent manual Disconnect distinct from temporary network loss, Quit and Log Out. Per-Mac settings with Connection, This Mac, Permissions and Updates sidebar sections.

Offer Accessibility and Screen Recording during optional setup; denial never blocks linking and no observation occurs in this release. Reuse Active sessions for Mac identity/revocation. Build/test locally first; paid Apple signing/notarization comes before public distribution. Updates use the official release channel with user-controlled installation.

## Next step

Review the spec and write the implementation plan for #2560: concrete pairing exchange, credential expiry/renewal, server-side scope/revocation, shared contracts/migrations, updater and release integration. No companion app implementation has started. Do not package the pilot or reuse a general Moss session token as a restricted device credential.

Keep the current approved design guide authoritative over exploratory mockups. Preserve the distinction between local build acceptance and signed public distribution. The user's shorthand “yr” means acceptance of the preceding recommendation. When delivering runnable Mac pilot changes during continued testing, Taildrop them instead of leaving the transfer to the user.
