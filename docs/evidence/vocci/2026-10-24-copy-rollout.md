# Meeting settings copy rollout — 2026-10-24

Task #3584; #3565 remains open. Plan `9d1047dd62cbfbbbc0bdbf04a52ca8ae5b1720c3`
preceded deployment-script writes and production maintenance. This slice delivers
only the existing merged Settings/Meetings copy cleanup; it changes no product
source. Merge, deployment and device acceptance are separate observations.

## Source and image boundary

Fresh production inspection found healthy source
`80256c8c74e1925ddc74d9da3778239baa54dd19`, before cleanup PR #3613.
The selected candidate is its exact merge source
`967bee00b1aa2119bc8ea55aa4b402f48898a6ff` and immutable image:

`ghcr.io/motioneso/moss@sha256:f4d01283751ec126f7feabd2d4b049cd6a2acaed6114634fbbfe0b2d68c19717`

The full intervening source delta is #3611's release notes and #3613's two
settings components, two app-map declarations and copy plan. There are no later
main changes, backend/schema/dependency changes or Android sources in the delta.
The historical publication job `120751409292` in main CI `40052349659` identifies
this digest. Both linux/amd64 and linux/arm64 attest candidate source above;
the pulled runtime image also bakes that exact revision.

PR #3613's immutable implementation
`54d7e0a7dc0fadfb8c22e91a7378d934bb5c5319` passed independent Standards/Spec
review, 58 focused tests, static verification, exact-head CI and isolated actual
Settings UI proof. Fresh checks confirmed the merge and successful main CI,
including both architecture builds/publication. Those historical product checks
are not represented as new local runs in this slice.

## Preparation and independent review

The existing separately authorized private coordinated-backup/provenance/config
procedure was read fully and adapted into a new private `copy-rollout/` directory.
No historical mutation script was executed unchanged. Candidate effective Compose
was compared with the customized deployment, in default and all-profile modes:
only ten existing Moss image references differ. Mounts, environment, overrides,
deployment controls and saved user choices stay authoritative.

Initial preparation stopped on a mount-array comparison. Read-only diagnosis
confirmed identical container/image and all per-destination mount fields; Docker
had returned array elements in another order. The corrected comparison ignores
order while retaining every field. The failed preparation is preserved privately.

Both independent reviewers identified the same operational P2: a successful backup
followed by an apply-guard failure could leave the original service stopped.
The corrected single-attempt coordinator restores only the unchanged original
container before candidate Compose replacement. After configuration replacement,
it preserves failure for diagnosis instead of restarting an older image.
Both re-reviews report zero remaining findings at pinned script digests.

Seven offline coordinator controls passed and were independently rerun: pre-apply
failure restores the exact old container and retains failure; post-apply failure
does not start it; changed container ID/image prevents restoration; already-running
old service is not started again; an existing attempt marker prevents child
execution; and success follows backup then apply. All Docker/child operations in
these controls were mocked. They verify runner failure handling, not production.

## Production execution

The reviewed coordinator exited 0. A fresh coordinated backup began at
08:38:07 UTC with app writers stopped and no other database client connections.
Database/roles and retained-file archives completed validation at 08:40:45 UTC;
archive byte counts and SHA-256 hashes are retained privately. Configuration was
copied into the same backup. This is a local validated backup, not off-host
storage or a restore-drill claim.

The guarded image-only apply exited 0 and the existing Compose project became
healthy on the candidate source/digest above. Fresh independent post-apply reads
at 08:41:44 UTC confirmed the running image/baked source, public HTTPS readiness
200 with database and job queue OK, equal per-destination mount fields, identical
environment/override hashes, and image-only effective configuration in default
and all-profile modes. No credential, deployment guard or mount was changed.

The existing selected transcription model and full saved Meeting preference
response compare equal before/after. No production settings save, provider change
or transcription request was issued by the proof. The new source contains no
migration delta; startup still used the ordinary guarded deployment path.

## UI evidence and limits

Before maintenance, actual signed-in Settings → Admin / Setup → AI providers
showed the older provider helper and an available saved transcription model.
Personal → Modules → Configure Meetings showed the old language helper, with
rendered language/audio choices matching the saved preference response. The
selected model and full Meeting preference response were captured privately
without saving settings.

The terminal browser's narrow managed viewport hid desktop category buttons, and
its CDP implementation rejected creation of a separate page. These failed observer
runs are retained. The supported terminal-browser CLI, fresh bounded snapshots and
actual responsive navigation supply the UI path; no intercepted response, token
export or private transcript is evidence. No screenshot is used.

After a full page reload, actual Admin / Setup → AI providers showed the short
instance-scope and audio-destination helpers. The existing available selected
model had no irrelevant setup/recovery note. Actual Personal → Modules → Configure
Meetings showed the short transcript-language and automatic-summary helpers.
Rendered language/audio choices and the full saved preference response matched
the pre-maintenance baseline; another full page reload retained the choices.
The terminal-browser CLI proof exited 0 with five recorded action/assertion steps.

The first post-apply observation read the still-open pre-maintenance SPA and
correctly failed the short-copy assertion. The next observer omitted an async
render wait after reload and failed before category navigation. Both failed runs
remain retained. A fresh reload with bounded actual-DOM/render waits supplied
the passing proof; neither failure is counted as product acceptance.

Production companion 20261027 is outside this server/web slice. No phone access,
reinstall, recording/replay, hold enrollment, source deletion, reset/rebind, reboot
or firmware operation is part of this work. Retained originals/imports, queues,
exclusions, signing/Keystore identity and official-app permission handoff remain
outside its mutations. No new physical recovery proof is claimed.

## Remaining queue

Keep #3565/#3584 open. Automatic package-replacement recovery remains unresolved;
prior successful physical reboot, manual Start recoveries and incomplete adapter
attempts retain their separate meanings. Adapter/out-of-range/offline and
interrupted-upload proof, separately opted-in production hold proof, reminder/
endurance checks, vocabulary decision/implementation, safe exact-source deletion,
original-preserving audio enhancement, firmware compatibility/recovery and
streaming remain within the existing handoff boundaries. Virtual Android is deferred.
Existing vocabulary-design and adapter-unlock requests must not be duplicated.
A fresh successor requires an independently actionable bounded slice, rather than
the same unchanged external blocker.

## Final verification and ownership

Applicable documentation formatting, file-size, no-dev-password and diff checks
are recorded with the final PR CI and independent Standards/Spec evidence review
before merge. No foundation gate or verification-only database command was run.
The separately authorized production backup is an operational snapshot.

Useful raw receipts, failed observers, reviewed script digests, successful backup,
provenance/config comparison and actual UI assertions are retained under
`~/.local/state/moss/vocci-recovery/copy-rollout/`. Owned browser cleanup is
recorded before the final merge. No owned server or devport was created.

Copy delivery is complete independently of the remaining external prerequisites.
No matching vocabulary-design or adapter-unlock reply was present at closeout.
Keep their existing AWAITING-BEN/needs-ben requests and originating routes; no
duplicate notification or successor into the same unchanged blocker was created.
Exclusive ownership remains with `vocci-copy-rollout` pending an actionable
bounded continuation and explicit transfer.
