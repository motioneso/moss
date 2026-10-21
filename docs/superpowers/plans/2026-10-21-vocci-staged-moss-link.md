# Vocci setup phase 2a: staged Moss account linking

Part of #3565 / draft PR #3566. Builds the next bounded slice of the
[approved design](../specs/2026-10-21-vocci-initial-ring-setup.md). The installed
native Vocci/backend feasibility gate passed; see the
[live evidence](../../research/2026-10-21-vocci-native-auth-proof.md).

## Current seams

- `apps/vocci-delivery/src/ai/moss/vocci/MossLink.java:19` requires committed
  configuration before browser linking. Leave the configured-owner path intact.
- `apps/vocci-delivery/src/ai/moss/vocci/MossClient.java:17` validates an HTTPS
  origin; `:39` restricts approval requests to the three existing pairing routes;
  `:70` checks the live device owner; `:74` revokes a device credential.
- `apps/vocci-delivery/src/ai/moss/vocci/SecretStore.java:34` atomically saves an
  encrypted record; `:55` removes it. Its separate alias/file constructor enables
  staging without publishing an incomplete `config.enc`.
- `packages/auth/src/companion-pairing.ts:316` cancels pending or redeemed attempts
  using the verifier, but `:87` purges expired attempts even when a credential still
  references them. A lost redemption response can lose its cancellation route.
  Retain expired attempts while a companion device references them. Keep expired
  pending approval nonredeemable. No new API, credential or migration is needed.
- `apps/vocci-delivery/src/ai/moss/vocci/DeliveryActivity.java:138` remains the
  configured-owner screen. The isolated proof package can exercise a new native
  linking screen without modifying the working companion or its queue.

## Decisions and boundaries

Add `SetupLink` rather than teaching the existing configured-owner reconnect flow
about partial configurations. Reusing that class would share approval mechanics,
but its replacement/revocation behavior assumes committed owner/ring identity and
is the wrong transaction boundary for an empty install.

`SetupLink` owns only a separate encrypted setup record. Its narrow transport port
covers approval requests, owner confirmation and credential revocation. Public
status exposes origin/account name and phase flags; credentials stay on the worker
side. Save the verifier before requests and a redeemed credential before owner
confirmation. An interrupted redemption retains its verifier for cancellation;
never automatically repeat a code send or create another approval attempt.

Cancellation is durable: mark cleanup requested, retry explicit logout for a known
issued credential and cancel the original attempt. Offline/unconfirmed cleanup
retains encrypted retry material. Never report cancellation complete before the
server confirms it. A committed configuration with the identical credential and
identity means staging cleanup is local only; a different/corrupt committed setup
requires recovery. Existing queue evidence without configuration blocks fresh
setup. Staging never constructs `DeliveryStore` or enables delivery.

The later physical-ring/atomic-commit slice will consume the staged Moss link.
This slice does not manufacture a runnable delivery configuration, select a ring,
enable hold input or change the production launcher. Keep the PR draft.

## Ordered work and verification

1. Add an Android integration regression: approve/redeem, advance past approval
   expiry, create another attempt, then cancel the original with its verifier.
   Wrong verifier must leave the credential valid; correct verifier must revoke it.
   Observe the existing purge losing cancellation, then fix the retention query.
   Existing expired-pending tests must keep passing. Add the focused pnpm script
   `test:integration:companion-pairing` for the repository's gate runner.
2. Add `SetupLink` and installed synthetic contracts for fresh start, origin pin,
   waiting/approval, restart before owner confirmation, lost redemption response,
   offline cancellation, expiry and completed-configuration reconciliation. Observe
   intended failures with the cleanup-retention and committed-credential guards
   removed, then restore them.
3. Add an isolated development-only browser-link screen using `NativeTheme`,
   stable address input, announced statuses and 48 dp controls. No placeholder
   production setup screen. Real UI: explicit Connect opens the existing Moss
   approval page; Check records account confirmation; Cancel confirms revocation.
   Record installed UI/backend evidence before calling this slice verified.
4. Update the proof guide/evidence and keep current production app-map claims
   accurate. No new product surface exists until integration; the existing guide
   continues to describe developer provisioning for the released companion.

Expected exit 0, unpiped:

- `scripts/run-gate.sh start --gate test:integration:companion-pairing`, followed
  once by `scripts/run-gate.sh wait --follow --log <returned-path>`; the red-control
  run must fail before the fix, and the restored final run must pass.
- `bash apps/vocci-delivery/proof/build.sh` and installed setup-link contracts.
- Scoped formatting, `git diff --check`, and APK signature verification.

Use only the verify-gate runner's disposable Postgres; no shared database tests.
Full foundation/CI and the complete first-run ring/delivery live path remain exit
criteria for #3565. All UI feedback comes from encrypted state and actual HTTP
results. The model has no job in this flow.

## Kill gate and next slice

Do not integrate the product wizard until interruption/cancellation leaves neither
an unintended active device credential nor a changed existing configuration.
Then build native ring selection, official-app handoff, physical identity/key
proof, atomic complete-configuration commit and explicit Start. A local or remote
approval failure gets a truthful retry state, never a successful connection claim.
