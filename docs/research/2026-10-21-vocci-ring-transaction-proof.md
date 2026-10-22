# Vocci selected-ring transaction: phase 2b checks

Part of #3565 / draft PR #3566. Implements the
[selected-ring transaction plan](../superpowers/plans/2026-10-21-vocci-ring-setup-transaction.md)
after the completed [staged-link live proof](2026-10-21-vocci-staged-link-proof.md).
The production launcher remains unchanged. The full native Verify-and-save flow is
**unverified**; this is not finished product onboarding.

## Implemented boundary

`SetupLink.selectBinding` validates/copies the selected connection address, serial,
device ID and binding key into encrypted setup staging. Status provides a selection
flag and serial suffix. `verifyAndCommit` passes a separate four-field copy to a
narrow ring-proof port. The production port opens/closes `RingConnection`, which
checks physical serial/device ID and the existing-key challenge using the canonical
connection address. No persisted verification flag substitutes for a fresh proof.

After ring proof, the transaction confirms the staged Moss owner again using an
account-only projection, rechecks for committed configuration or orphaned delivery
state, then uses the existing atomic private writer to publish a complete config.
Reconciliation compares both the staged account credential and selected ring.
Cancel removes candidate fields before attempting remote cleanup. This path does
not construct `DeliveryStore`, start delivery or enable hold-to-talk.

The isolated native proof now reveals a ring-selection section after a staged Moss
link. It offers the real account inventory only after temporary Vocci session
cleanup. Explicit selection releases the inventory; restart before selection needs
another sign-in, while a staged selection survives. Bluetooth connect permission
is explicit, with no scan permission. The official-app settings action supports
Nearby devices handoff without disabling the package. No service is declared in
the proof application. Its UI uses `NativeTheme`, native labeled controls, a ruled
section and at least 48 dp targets. These are implementation observations; the new
screen has not yet passed installed live UI, theme or font-scale acceptance.

## Observed checks

The final installed proof APK SHA-256 is
`1c2a03c67335112a322217cab1f0f1835c648cfc66e902e0f3ddfbb0f81d636a`.
Installed synthetic instrumentation passed:

- `SetupRingChecks`: 28 contracts, including missing prerequisites, selected-field
  projection/copying, malformed candidates, retry after failed physical proof,
  fresh-owner network failure, revoked credential and changed owner, interrupted
  commit recovery, conflicts in every committed ring field, orphaned queue
  appearing during proof, offline cancellation and recreated controllers.
- Existing `SetupLinkChecks`: 27 contracts.
- Existing `VocciAuthChecks`: 39 contracts.

These contracts use dedicated synthetic stores and synthetic network/ring ports;
they neither authenticate the physical ring nor establish actual vendor acceptance.
The prior real native sign-in and real staged Moss approval proofs remain separate.

Protection-removal controls were built and exercised on the installed app:

- Removing the physical proof call failed at
  `commit_requires_fresh_ring_and_owner`.
- Removing only the new pre-commit owner request failed at
  `commit_requires_fresh_ring_and_owner`.
- Removing the selected-ring comparison during adopted-configuration recovery
  failed at `guard_missing_setup_recovery_required`.
- Replacing the selected-field projection with a full candidate copy failed at
  `selection_is_copied_and_projected`.

All four controls were restored, then all three installed suites passed again
(94 contracts). The selected-field projection control was completed after the
initial transaction commit; it uses synthetic candidates with extra fields.

Host crypto vectors, transfer/restart checks and WAV checks passed, including a
generated two-hour WAV under the existing constrained heap. Sequential host and
proof builds and APK signature verification passed. This does not add a two-hour
hardware recording result.

## Live selection and physical diagnosis

Canonical live run `20261021-194231` on clean `d7a0959f4`
(inputs `ae6aa121dafc`) passed real browser-approved Moss staging, native account
confirmation/restart, owner-entered Vocci sign-in, read-only account inventory,
confirmed temporary-session cleanup, explicit ring selection and selection restart.
Android's actual permission UI removed the official app's Nearby devices access.
The phone relocked during that handoff; the harness could not reach Verify. The
full run exited 1 and is **not** a configuration-commit proof. Browser sign-out
cleanup was not confirmed; the canonical runner destroyed its disposable server
and database. Isolated staging was then removed after confirming that teardown.
No original companion configuration or queue was edited.

A development-only `SetupPhysicalCheck` then opened/closed `RingConnection` with
the same actual UI-selected candidate before staging cleanup. It returned
`result=PASS`, `configurationPresent=false`, instrumentation code `-1`: physical
serial/device identity and the existing-key challenge passed. It neither confirms
a fresh Moss owner nor commits configuration, and cannot replace the remaining
real native Verify-and-save acceptance. It returns only bounded diagnostic codes.

## Remaining acceptance

The subsequent canonical retry `20261021-195535` tested clean `1ce17b391`
(inputs `22ede0407d7d`) and exited 1 while waiting at the initial secure phone
lock, before a Moss link or Vocci sign-in. Installed state inspection afterward
confirmed `EMPTY`, no staging and no configuration. The runner removed its
disposable server; no setup acceptance is claimed for this retry.

No new recording is needed for this slice. Next run the real native account
selection, permission/handoff and physical identity/key proof against a disposable Moss account, then verify cancellation and
interrupted-commit recovery. Preserve the original companion's configuration and
queue; restore any temporarily paused delivery preference after the controlled
physical check.

Only then proceed to the integrated product wizard, explicit Start, fresh Meeting
and opted-in hold-to-Main proofs, upgrade/recovery checks, guide and app-map updates.
Full foundation and CI remain required on final inputs. Keep #3565 open and PR #3566
draft; no production deployment or merge is claimed.
