# Deploy the merged Meeting settings copy cleanup

Task #3584; #3565 remains open. Scope: the existing approved Settings/Meetings
copy cleanup, not vocabulary or a new product feature. Authority: merged
`2026-10-24-vocci-copy-rollout-continuation.md`, the existing separately authorized
coordinated backup/provenance/config-comparison procedure, and explicit exclusive
runtime transfer to this session. No new device operation is needed.

## Exact source boundary

Fresh read-only production inspection found healthy source
`80256c8c74e1925ddc74d9da3778239baa54dd19`. The cleanup is not deployed there.
Candidate source is the exact merged copy PR #3613,
`967bee00b1aa2119bc8ea55aa4b402f48898a6ff`, never a moving main/edge tag.
The complete intervening first-parent changes are:

- #3611 (`9d0eb099b`): generated release notes only.
- #3613 (`967bee00b`): shorter Settings/Meetings helpers, conditional provider
  setup/recovery advice, and matching core/module app-map descriptions.

`git diff` of those immutable endpoints contains only the two settings components,
two app-map declarations, the existing copy plan and release notes. No backend,
ASR, schema, credentials, Android or dependency change is included. Later unrelated
main changes are excluded. Existing copy-plan approval, exact implementation
`54d7e0a7dc0fadfb8c22e91a7378d934bb5c5319` independent Standards/Spec reports,
58 focused tests and isolated real UI proof are recorded on #3613. Main CI
`40052349659` passed including both image builds and publication. Recheck all
records before relying on them; merge and deployment are separate claims.

## Seams and decisions

- `apps/web/src/settings/settings-transcription-config-group.tsx:76` owns
  instance-wide transcription copy; the conditional notes at lines 132–142
  preserve failed/loading reads and show setup/recovery help only when relevant.
- `packages/meetings/src/web/meeting-settings-form.tsx:112` owns language and
  summary helpers. The owning manifest and core app map changed in #3613.
- `.github/workflows/ci.yml:515` publishes per-architecture images; lines
  519 and 550 bind the baked revision and assembled image. Recover the historical
  immutable digest from the exact publication job, then verify its manifest and
  each architecture's provenance against the candidate source. Mutable edge is
  evidence of neither source nor scope.
- Existing private `production-prep/window-rollout/` contains preparation,
  coordinated backup and guarded image-only apply scripts. Read them fully, adapt
  into a new private receipt directory and independently review the actual new
  scripts. Do not execute old guards with stale container/config/backup identities.
- Preserve customized Compose, overrides, mounts, environment and all effective
  settings across default and all-profile configurations. Permit only the ten
  existing Moss image references to change to the reviewed immutable digest.
- Retain the complete fresh DB/roles/files/config backup locally with hashes and
  archive validation while app writers are stopped. Backup is not a restore drill
  or off-host recovery claim. Stop on unknown writers or deployment drift.
- UI assertions are read-only: use supported existing sign-in, inspect the actual
  Settings provider and Meetings surfaces, and compare saved preferences before
  and after. Do not change provider, language, summaries, credentials or recordings.

All feedback comes from existing records and actual rendered UI. No model has a
job in deployment, readiness, save confirmation or settings verification.

## Ordered delivery and kill gates

1. Commit this plan before code/deployment writes. Capture exact production
   source/container/config/mount identities privately. Verify candidate manifest,
   both-architecture attestations, baked source, final CI and historical reviews.
2. Prepare new private scripts, receipt paths and image-only candidate Compose.
   Recheck source delta and effective configuration. Independent Standards and
   Spec agents review the immutable plan and pinned script/evidence digests;
   resolve and re-review every actionable finding before maintenance.
3. Only if all guards pass, announce brief maintenance, take a fresh coordinated
   validated backup, then run guarded image-only apply. Unknown drift stops before
   apply. A pre-apply failure restores the original app service. Startup failure
   after migrations is diagnosed in place; do not blindly downgrade the image.
4. Verify actual running digest, baked source, health/readiness and unchanged
   effective config/mounts. Through the real production UI assert the shortened
   helpers and relevant guidance, plus retained choices, using bounded text only.
   No intercepted responses or fabricated acceptance states. An unavailable UI
   sign-in remains an explicit verification blocker.
5. Record exact execution, backup/provenance/config and UI assertions publicly
   without private hostnames, identifiers, recordings, secrets or raw logs.
   Independently review immutable final base/head/evidence, pass docs checks and
   required CI, then merge under standing authorization. Deployment results remain
   distinct from this documentation merge.

Kill-gate owner: this session. Missing exact image/source/architecture provenance,
changed configuration, missing authorization/reviews/CI, unknown writers or a
broader source delta stops deployment. Do not substitute latest main. Preserve
failed receipts, user data and current working production state.

## Verification and continuation

Scoped Prettier, `pnpm check:file-size`, `pnpm check:no-dev-password` and
`git diff --check` must exit 0, unpiped. Required final docs CI must pass. Existing
product checks describe their original source; do not claim them as fresh local
runs. No new tests or DB verification command is planned; any such command needs
`verify-gate`. The separately authorized operational backup is not a test gate.

Close owned browser/server resources and release any reserved devport. Keep useful
private receipts outside git, commit/push only explicit docs paths and finish clean.
Carry the full queue in the recovery/copy-rollout handoffs. Existing vocabulary
design and adapter unlock requests stay pending without duplicates; no phone
access, reinstall, replay, hold enrollment, source deletion, reset/rebind, reboot
or firmware operation is part of this slice. Production companion 20261027 stays
installed. Virtual Android remains deferred. Start a fresh isolated successor
only for an actionable next slice, never the same unchanged external blocker.
