# Signed Moss Module Catalog

**Issue:** #1319

**Status:** Approved by Ben on 2026-08-17

## Problem Statement

Moss cannot currently prove that a downloaded module came from the catalog Moss recognizes and vets. The catalog is fetched over TLS and contains SHA-256 fingerprints for its artifacts, but the catalog itself is unsigned. If that catalog were replaced, an attacker could replace both a module entry and its expected fingerprint and the existing installer would accept them together.

Users should receive the safe default without needing to understand signing. Moss maintainers and module developers need a reliable way to distinguish modules recognized by Moss from unverified modules, while an authorized user must still be able to accept the risk of an unverified catalog explicitly.

## Solution

Moss will cryptographically sign its official module catalog. Installed Moss releases will contain the trusted public keys needed to verify that signature. Because the signed catalog already contains the exact SHA-256 fingerprint and size of every recognized module artifact, verifying the catalog also authenticates those artifacts without adding a separate signature to every module.

Verified catalog modules will continue through the existing download, fingerprint verification, safe extraction, staging, restart, and enablement flow. An absent, unknown-key, or invalid catalog signature will block installation by default. An authorized admin may make a one-time, conspicuous risk acceptance for the exact unverified catalog snapshot they reviewed; this exception will not become a saved preference or weaken any other installer validation.

## User Stories

1. As a Moss user, I want recognized modules to install normally, so that supply-chain protection does not add routine friction.
2. As a Moss user, I want unverified modules blocked by default, so that I do not accidentally run code Moss cannot authenticate.
3. As an advanced Moss user, I want to accept the risk of an unverified catalog explicitly, so that Moss does not become a closed ecosystem.
4. As an advanced Moss user, I want the warning to explain that Moss cannot verify the catalog's origin, so that I understand the decision I am making.
5. As an advanced Moss user, I want my exception to apply only to the catalog snapshot I reviewed, so that changed content requires a new decision.
6. As a Moss user, I want a changed or tampered module artifact rejected even after I accept an unverified catalog, so that the downloaded bytes must still match the reviewed catalog entry.
7. As a Moss user, I want unsafe archives, invalid manifests, incompatible modules, and excessive downloads rejected regardless of any catalog override, so that accepting one risk does not disable unrelated protections.
8. As a Moss administrator, I want the module screen to distinguish verified and unverified catalog data, so that I never mistake untrusted metadata for Moss-vetted content.
9. As a Moss administrator, I want verification failures expressed as safe, actionable product errors, so that raw cryptographic or network output is not exposed.
10. As a Moss administrator, I want an unverified catalog refresh to leave installed modules usable, so that a catalog problem does not disable already accepted local modules.
11. As a Moss operator, I want non-interactive ensure-at-boot installs to skip unverified catalog content and continue booting with a warning, so that automation fails closed without bricking the instance.
12. As a Moss maintainer, I want the catalog signed during the existing publish workflow, so that every newly published catalog is protected automatically.
13. As a Moss maintainer, I want publishing to fail when signing is unavailable or the generated signature cannot be verified, so that an unsigned official catalog is never released accidentally.
14. As a Moss maintainer, I want the signing key isolated from module source and release assets, so that public repository access cannot produce a trusted catalog.
15. As a Moss maintainer, I want signatures to identify their signing key, so that key rotation does not require guessing which key verifies a catalog.
16. As a Moss maintainer, I want old and new verification keys to overlap during rotation, so that supported Moss installations continue working while the publisher changes keys.
17. As a module developer, I want inclusion in the signed catalog to be the recognition signal, so that I do not need to manage a separate per-module signing identity.
18. As a security reviewer, I want direct API downloads governed by the same verification policy as the UI, so that bypassing the browser does not bypass catalog verification.
19. As a security reviewer, I want catalog authenticity checked before its module metadata is treated as trusted, so that attacker-controlled names, URLs, fingerprints, or capabilities do not silently enter the trusted path.
20. As a support operator, I want logs to distinguish network, schema, signature, and artifact-integrity failures without recording secrets or private module content, so that failures can be diagnosed safely.

## Implementation Decisions

- The trust object is the module catalog index, not each module artifact. A valid catalog signature authenticates the catalog's existing artifact fingerprints and therefore the exact artifacts listed by Moss.
- Use Ed25519 through the platform cryptography library. This keeps the implementation dependency-free and provides a small, purpose-built signing and verification primitive.
- Publish a detached signature metadata asset beside the catalog. It contains a format version, algorithm, key identifier, and base64 signature. The signature covers the exact UTF-8 bytes of the published catalog.
- Generate the catalog bytes once, sign those exact bytes, verify the result inside the publish job, and then upload the catalog, signature metadata, and artifacts together. Publishing fails if the private key is missing, signing fails, or the self-verification fails.
- Keep the private signing key only in the GitHub Actions secret store used by the module-catalog release workflow. It must never enter the repository, release assets, application image, logs, or runtime configuration.
- Pin a small keyring of trusted public keys in Moss. Signature metadata selects a key by stable identifier; unknown keys are unverified, never guessed or fetched from the catalog source.
- Rotate keys with an overlap: ship the next public key in Moss before the publisher starts using its private key, retain the previous public key through the supported upgrade window, then remove it in a later release. Compromise response uses the same mechanism but may intentionally invalidate old catalogs.
- Fetch the catalog and detached signature through the existing host-pinned registry network path with independent size caps. Verify the signature over the raw catalog bytes before parsing or accepting the catalog as trusted.
- Return catalog verification state with the registry listing: `verified`, `unverified`, or `unavailable`, plus a SHA-256 digest identifying the exact fetched catalog snapshot. Unverified rows must be visibly marked and must not be described as vetted or recognized by Moss.
- Preserve the existing ten-minute cache, but cache catalog bytes/digest, verification state, and parsed entries together. A refresh replaces the snapshot atomically; verification state must never be combined with entries from another fetch.
- The normal admin download request remains the trusted path and requires a verified catalog. An unverified catalog returns a conflict response that contains a safe reason and the current catalog digest instead of staging files.
- The explicit override is a second request carrying the exact unverified catalog digest the admin accepted. It is admin-only, one attempt, and not persisted. If the current digest differs, Moss rejects the request and requires a fresh warning and confirmation.
- The confirmation UI must clearly state that Moss did not authenticate this catalog and that installing may execute untrusted code after restart. It requires deliberate acknowledgement and names the target module; it must not be a generic dismissible warning.
- The override bypasses only catalog-signature verification. Artifact size and SHA-256 matching, pinned download hosts, safe extraction, manifest validation, module-id/version matching, compatibility checks, staging, drift detection, and enablement rules remain mandatory.
- A signature-valid catalog entry whose artifact fails its fingerprint check is always rejected. There is no override for contradictory or changed artifact bytes.
- Non-interactive ensure-at-boot has no bypass channel. An unverified catalog produces a bounded warning, skips the requested download, and allows the rest of boot to continue.
- Already installed local modules remain available according to their existing enablement and drift rules when the remote catalog is unavailable or unverified. This feature governs recognition and new catalog-driven downloads, not retroactive disabling.
- Direct API callers use the same digest-bound override contract as the UI. There is no alternate direct-download path that omits catalog verification.
- Rollout publishes a signed catalog and its detached signature before releasing enforcement. Older Moss versions continue using the catalog as before; enforcing versions immediately verify it. No database migration or unsigned transition mode is required.
- The product term is **recognized by Moss** or **verified catalog module**. Avoid claiming that signing proves the module is harmless, sandboxed, or comprehensively security-audited; signing proves provenance and byte identity.
- No new package or signing service is introduced. The existing catalog publisher, registry fetcher, distribution pipeline, shared admin contracts, and module-management UI are extended at their current seams.

## Testing Decisions

- The primary seam is the existing admin module-registry list and download boundary. Tests assert externally observable listing, warning, blocking, override, and staging behavior instead of cryptographic helper internals.
- Extend the existing module-distribution end-to-end harness so a signed mock catalog lists as verified and its module downloads and stages through the normal admin route.
- At the same seam, prove that missing, malformed, unknown-key, and incorrect signatures are unverified and blocked by default without staging files.
- Prove the explicit override succeeds only when its accepted digest matches the current unverified catalog and the artifact still matches the catalog's size and SHA-256 fingerprint.
- Prove a catalog change between warning and retry invalidates the acknowledgement and produces a fresh conflict rather than installing.
- Prove an artifact fingerprint mismatch remains blocked even with a correct unverified-catalog override.
- Prove safe extraction, manifest, compatibility, host-pinning, size-cap, and module-id/version failures remain unchanged under the override.
- Prove direct API requests and UI-driven requests exercise the same policy, including admin authorization before verification details are returned.
- Prove registry refresh and cache behavior never pair entries or verification state from different snapshots.
- Prove ensure-at-boot skips an unverified catalog, records a bounded warning, installs nothing, and continues reconciliation.
- At the publishing seam, prove deterministic catalog bytes produce a verifiable Ed25519 signature, an absent private key fails the release build, and altered catalog bytes fail verification.
- Prove key rotation accepts both current and next trusted key identifiers during overlap and rejects an unknown or retired key.
- Use the existing module-distribution pipeline, publisher, index-schema, and end-to-end route suites as prior art. Add focused cases there rather than creating a new security test framework.
- Live verification installs a verified catalog module successfully, demonstrates the unverified warning and default block, accepts one exact unverified snapshot deliberately, and confirms a changed snapshot requires new consent.

## Out of Scope

- Individual signatures for each module artifact.
- Independent publisher identities, certificates, or a public web-of-trust.
- Third-party registry discovery or arbitrary registry URLs in production.
- Proving that recognized module code is safe, bug-free, sandboxed, or comprehensively reviewed.
- Changes to what an enabled module may do at runtime.
- Bypasses for artifact fingerprint mismatches, unsafe archives, invalid manifests, incompatible versions, disallowed hosts, or size limits.
- A permanent "allow unsigned modules" setting, silent fallback, or instance-wide disablement of verification.
- Retroactively disabling already installed modules solely because the remote catalog is unavailable or unverified.
- Database schema changes or migration of installed module records.

## Further Notes

- Downloading and staging a module still does not execute it; restart/reconciliation and enablement remain the steps that make module code active.
- The explicit risk path is intentionally narrower than the original issue's proposed unconditional fail-closed behavior. Ben confirmed that Moss should protect users by default without completely preventing advanced users from accepting the risk.
- Acceptance is demonstrated by four outcomes: a verified module installs normally; an unverified catalog is blocked by default; the exact unverified snapshot can be installed only after deliberate admin acceptance; and tampered catalog or artifact bytes cannot ride a stale acknowledgement.
