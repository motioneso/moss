# Phase 6 part 6: local package trust (JS-408)

This slice establishes local signing and verified provenance. It does not activate local
packages or implement their lifecycle, navigation, tools, jobs or exports; part 7 owns those
paths and their isolation checks.

## Contract

- First local signing generates one Ed25519 key in the existing host keystore. Its PKCS#8
  private half is stored only in an AES-256-GCM envelope next to the credential-key bundle.
  The envelope authenticates the installation identity inside its encrypted payload.
  A cross-process file lock serializes generation. Verification never creates a key.
- The host derives `local.<account UUID>.*` from authenticated `AccessContext`. The owner
  segment must be the canonical UUID, not an account name. Request schemas accept no owner.
- New migration `0006_local_packages.sql` creates public install trust and owner-scoped local
  package records. It is registered in the existing module schema bootstrap. The pinned
  installation identity, public key and fingerprint cannot silently change. Local provenance
  is fixed to `local`, and registry review is fixed to false.
- Signature, digest, archive, manifest, SQL and Wasm-import checks run before recording a
  package. The SQL/import helper is shared with registry activation and publisher verification.
  Registry publisher trust refuses the `local.` namespace.

## Commands

From `~/Jarv1s`, use the existing `moss pack DIRECTORY PACKAGE` command, then:

```sh
moss local sign https://your-moss-origin PACKAGE SIGNATURE_OUTPUT
moss local verify https://your-moss-origin PACKAGE SIGNATURE_INPUT VERIFY_OUTPUT
```

`MOSS_LOCAL_SESSION` supplies the signed-in session cookie through the existing secret
runner, not a command-line argument. `MOSS_LOCAL_CA` can name a public local CA certificate.
The client refuses redirects and accepts plain HTTPS origins only. The server derives the
account from its session middleware. The CLI writes only the public signature envelope.

The current keystore backend is Unix-only. Local signing routes use that backend on Unix;
Windows keeps its existing server behavior without these new routes. Windows key custody is
not implemented or proven here. Host secret storage must already be set up and unlocked;
these commands never create a recovery store or disclose recovery material.

## Verification

Focused runner (disposable database, real TLS server, real session and CLI):

```sh
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js408-target scripts/run-gate.sh start --gate test:rust-phase6-local-trust
scripts/run-gate.sh wait --follow
```

Guard-removal controls (one cargo process at a time; restores files even on a failure):

```sh
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/js408-target python3 rust-spike/module-host/tools/local-trust-negative-controls.py
```

The initial suite was run before the host module was wired in and exited 101 for the missing
local-trust API. The restored suite passed twelve tests. Nine guard-removal runs each failed
its named assertion: install label, key fingerprint label, owner, prefix, wrong signing key,
changed bytes, undeclared imports, invalid SQL and registry-local namespace confusion.
The first SQL control exposed an invalid migration filename in the fixture; it was corrected
so that the refusal specifically reaches the SQL subset checker.

Full gate and maintainability results are recorded with the task's proof artifact after the
current run completes. Cross-platform signing, private lifecycle and isolation across guest
entry points are not proven by this slice.
