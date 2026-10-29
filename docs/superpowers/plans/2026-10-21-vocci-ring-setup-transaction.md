# Vocci setup phase 2b: selected ring and configuration commit

Part of #3565 / draft PR #3566; follows the
[staged Moss link](2026-10-21-vocci-staged-moss-link.md) and the
[approved existing-owner spec](../specs/2026-10-21-vocci-initial-ring-setup.md).
Do not integrate the product launcher before phase 2a's installed link/cancel
proof passes. This slice adds the ring transaction; the integrated wizard and its
fresh-delivery proof remain the following bounded slice.

## Verified seams

- `VocciAccount.java:122` returns the validated account binding list only after
  verified sign-in; `:133` removes the temporary setup session. The existing
  proof discards this list after counting it. Preserve the list in memory only
  long enough for explicit selection, then release every unselected key.
- `VocciBindings.java:8` validates the returned inventory, rejects ambiguous
  identities and returns exactly address, serial, device ID and binding key.
  This is an account inventory, not a Bluetooth scan.
- `SetupLink.java:35` owns separate encrypted staging. Its serialized entry
  points refresh state, reject existing configuration/orphaned delivery state,
  and reconcile an adopted Moss credential without revoking it.
- `RingConnection.java:41` opens the configured connection address, checks
  physical serial/device ID and performs the existing key challenge. It uses
  the canonical connection MAC for authentication. Its identity response's MAC
  byte order does not establish a backend-address reversal requirement.
- `SecretStore.java:34` publishes configuration using the existing atomic private
  writer; `:59` rejects replacement identity changes. `DeliveryPreferences` and
  `DeliveryActivity.command` keep Start explicit. Setup must not construct
  `DeliveryStore` or silently enable delivery/hold.

## Decisions

Extend `SetupLink`'s transaction rather than adding another independently committed
ring store. Add explicit selected-binding staging and a `RingProof` port used by
verify-and-commit. The production port opens/closes `RingConnection` using only
the four selected ring fields. Public status exposes a serial suffix and selection
flags; it never returns a binding key or Moss credential.

Validate/copy only those four fields into encrypted staging after explicit
selection. Replacing an uncommitted candidate is allowed; replacing committed
identity is not. Failed physical proof retains a retryable selection and publishes
no configuration. Do not persist a reusable "verified" flag: process death before
commit requires fresh physical proof.

Commit requires the staged confirmed Moss account, a selected validated candidate,
physical identity/key proof, and fresh Moss owner confirmation. Recheck the
unconfigured/queue guards inside the serialized operation before atomic save.
Reconcile committed configuration plus stale staging after interruption; compare
selected ring identity too when a candidate exists. Cancel removes candidate keys
before network cleanup and retains only retryable Moss cleanup material.

Vocci sign-in remains separate. No new code is sent automatically. Clean up its
temporary session after lookup; unconfirmed cleanup remains visible/retryable.
The UI must not treat a successful account lookup as physical verification.
All feedback is derived from records and actual API/ring observations. The model
has no job in this transaction.

## Ordered work and verification

1. Add installed contracts for selected-only persistence, malformed candidates,
   proof failure, owner mismatch/revocation, process restart, interrupted atomic
   save and adopted-configuration reconciliation. Observe intended failures with
   proof-before-commit and committed-identity protections removed, then restore.
2. Add selection and verify-and-commit APIs behind the narrow proof port. Preserve
   all existing staged-link contracts and the configured reconnect path.
3. Exercise the real native selection/proof path in the isolated package before
   product integration. Add Bluetooth-connect permission only for this proof;
   request it explicitly, explain official-app Nearby devices handoff, and never
   disable the official package. Keep the working companion's queue/configuration
   intact and restore its prior delivery setting after a controlled ring check.
4. Record actual backend, physical proof, cancellation and recovery evidence.
   Update the proof guide. Do not describe the product launcher as upgraded yet.

Run the sequential host/proof builds and installed contracts unpiped, expecting
exit 0. Never overlap those builds because they share compiled output. Run any
DB checks only through `scripts/run-gate.sh`. The full foundation and CI gates
remain required on final inputs before the overall wizard is finished.

## Kill gate

A backend binding must authenticate the selected physical ring without resetting
or writing ownership. A mismatch, unsupported account method or failed proof
blocks configuration publication. Preserve the evidence and correct the adapter;
never substitute copied keys, guessed MAC reversal or developer provisioning for
successful user-facing setup.
