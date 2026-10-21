# Vocci setup phase 1: installed native sign-in proof

Part of #3565 and draft PR #3566. Ben approved the
[setup spec](../specs/2026-10-21-vocci-initial-ring-setup.md) in chat on
2026-10-21: “Approve!” This plan covers the feasibility gate only.

## Current seams

- `apps/vocci-delivery/build.sh:24` compiles Java 11 against Android 35 without
  Gradle or third-party runtime dependencies. Its release branch excludes device
  checks and requires externally supplied release signing.
- `apps/vocci-delivery/src/ai/moss/vocci/SecretStore.java:21` accepts separate
  encrypted file/Keystore alias names; `:34` saves through `PrivateFiles`; `:44`
  bounds reads. Use a separate temporary Vocci setup-session store.
- `apps/vocci-delivery/src/ai/moss/vocci/MossLink.java:19` requires full existing
  configuration. Do not change it before this feasibility gate passes.
- `apps/vocci-delivery/src/ai/moss/vocci/SecretStore.java:59` pins the committed
  owner/origin/ring. This proof does not write the committed delivery config.
- `apps/vocci-delivery/src/ai/moss/vocci/NativeTheme.java:17` supplies native
  typography and semantic colors; `:48` supplies accessible button targets.
- `apps/vocci-delivery/src/ai/moss/vocci/RingConnection.java:41` opens a physical
  ring session. Phase 1 does not instantiate it or access the delivery queue.

The official native authentication contract and current public configuration are
recorded in the [authentication research](../../research/2026-10-21-vocci-initial-setup-auth.md).
Actual native-session acceptance by the binding backend is an open question owned
by this build, resolved only through the installed owner flow below.

## Adapter choice

Use a small direct native HTTPS adapter for the email-code/TOTP subset. The
current build has no dependency resolver. The official SDK offers a broader,
maintained auth state model and is preferable if the subset cannot be implemented
against the published contract; adopting it would also require introducing its
Kotlin/Android dependency graph and auditing its storage/logging middleware.
Direct implementation keeps this first experiment small. Trace the actual native
request/session/cleanup contract before coding; do not guess callback behavior.

## Ordered work

1. Add a fixed-destination native HTTP adapter and `VocciAccount` with explicit
   begin, resend, email verification, required TOTP, read-only bindings and
   current-session cleanup operations. No sign-up/reset/binding-write operations.
   Bound responses and timeouts, reject redirects, identify Moss truthfully and
   turn remote failures into safe local status codes. Never render raw responses.
2. Retain only cleanup/session material in a separate encrypted record. An
   interrupted attempt starts afresh without automatic email sends; discover and
   clean up any session created by a lost verification response before discarding
   the device credential. Failed cleanup remains retryable. No session belonging
   to another client is removed. No promise of JVM string erasure.
3. Add an isolated development proof package with email/code/TOTP controls, a
   truthful account-ring count and explicit cleanup. Reuse production adapter
   classes. Keep it out of release APKs. Preserve the installed companion and all
   its data; do not read its private configuration into the proof.
4. Add installed contract checks with synthetic transport responses for email,
   MFA, invalid code, unsupported factors, lost response/restart cleanup, malformed
   and ambiguous bindings, redirect/oversize rejection and safe errors. Security
   assertions need guard-removal controls observed failing. These fixtures are
   contract tests, never live acceptance evidence.
5. Build/install the proof, then exercise the real UI on the owner's phone:
   explicit email send → verify → required MFA → backend binding GET → explicit
   session cleanup. Record bounded executable assertions and status/count evidence
   without account identifiers, codes, tokens or keys. Use the real client identity.

## Determinism and verification

All feedback derives from local attempt records and actual API responses. No model
has a job in authentication, selection, cleanup or setup completion. This phase
adds no chat turns. Later audio-processing behavior is unchanged.

Commands run unpiped, expected exit 0:

- `bash apps/vocci-delivery/test.sh` (existing host checks plus APK compilation).
- `bash apps/vocci-delivery/proof/build.sh` (isolated proof APK).
- Installed `VocciAuthChecks` instrumentation (explicit assertion result).
- Scoped Markdown formatting and `git diff --check`.

No DB tests in phase 1. Any later DB checks must use the repository verify-gate
skill. Native Android executable UI assertions replace browser-only Playwright
for this native surface; real backend requests must not be intercepted or replayed.

## Kill gate and next phase

If native sign-in, required MFA, truthful client identity or the binding GET is
rejected by vendor policy, stop this approach. Ben decides any revised integration
scope after the specific evidence is reported. Do not broaden into token exports,
embedded login scraping, package impersonation or undocumented bypasses.

Only a real installed sign-in and backend acceptance permits planning the
remaining staged Moss link, selection, physical proof and completion wizard in
detail. This phase alone is not finished initial setup and cannot close #3565.

## Rulings ledger

- 2026-10-21: Ben approved existing-owner native email-code feasibility first.
- Existing configured owners do not repeat sign-in or key recovery (approved spec).
- Cloud binding retrieval is not physical ring verification (approved spec).
