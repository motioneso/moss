# Vocci phone session: out-of-range and interrupted-upload checks

Physical acceptance checks for #3565 / #3584 under the approved spec
`docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md`. Ben chose to run this session
now (2026-10-25) and is at the keyboard with the phone and the ring.

## Goal

Prove two behaviors on the real production phone, ring and Moss, through the product:

1. **Out of range / offline.** A recording made while the ring cannot reach the phone is
   delivered to Moss automatically once the ring is back in range. No manual retry.
2. **Interrupted upload.** An upload cut off partway (for example, phone network off during the
   transfer) resumes or retries and reaches Moss exactly once, with no duplicate Meeting.

Each check is pass, fail or blocked, with evidence. A failure is a finding. Diagnose it and
open an issue; don't patch production mid-session.

## Read first

- `docs/coordination/AWAITING-BEN.md`, the Vocci entry dated 2026-10-24.
- The newest Vocci continuation handoffs in `docs/superpowers/handoffs/` (2026-10-24-*). They
  describe the delivery client, the observer tooling and the private runtime notes. Read the
  private notes they point to for device and account details. Never commit those details.
- `apps/vocci-delivery/` README files and the observer and recovery scripts under
  `upgrade-proof/`.
- Hindsight: search "vocci delivery", "vocci observer", "out of range".

## Rules

- Ben does the physical steps (walk away with the ring, record, toggle the network). Give him
  one short plain-English step at a time and wait for "done". Say what you expect to see before
  each step.
- The phone is attached over ADB (check `adb devices`). Use it to observe: logs, the
  delivery client's state, the queue. Don't change settings without telling Ben first. Restore
  anything you change, and keep a private note of the original values.
- Keep delivery enabled, hold-to-talk off, the source cleanup choices, the official app's
  Bluetooth permission handoff and the phone's original screen timeout exactly as you find them.
- No production database reads or writes. Confirm arrival through Moss's own screens or API
  (the Meetings list).
- Don't replay old recordings or retry old summaries from earlier notes.
- Another session is finishing PR 3693 (ring chat stray dot). Don't touch that branch.
- This repository is public. Keep hostnames, addresses, device ids, credentials and transcripts
  out of committed files.

## Finish

- Record the results in a short docs PR on this branch. Update the Vocci AWAITING-BEN entry:
  remove the items that passed and keep anything still blocked, with the exact reason. Release
  note is `Category: N/A`. Merge with `gh pr merge --squash --auto` once green.
- Open an issue for each failure, with the evidence.
- Restore the phone state, stop anything you started, and leave the worktree clean.

## Start

Run `pnpm install`, read the files above, then check `adb devices` and the current delivery
state. Tell Ben what you see and give him the first step.
