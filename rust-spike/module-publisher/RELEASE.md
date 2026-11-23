# Rust first-party release and stand-in bootstrap (M7)

This pipeline is separate from the TypeScript catalog. It writes only the rolling
`rust-modules` release. `.github/workflows/modules-registry.yml` stays unchanged.
Real installers, host deployment and production cutover remain Phase 7.

## Build and review

From `~/Jarv1s`, set `RUSTUP_HOME` explicitly and use a task-owned `CARGO_TARGET_DIR`.
Every Cargo invocation runs sequentially with two build jobs and debug information off.
The declared Rust 1.95.0 toolchain needs `wasm32-unknown-unknown` and `wasm32-wasip2`.
Python 3.11 or newer uses only its standard library. No globally installed Wasm CLI is needed;
the existing component encoders and UI bindgen crates do that work.

```sh
python3 rust-spike/module-publisher/tools/build_first_party.py /tmp/rust-first-party
cargo +1.95.0 run --locked --manifest-path rust-spike/module-publisher/Cargo.toml \
  --bin moss -- release /tmp/rust-first-party /tmp/rust-release --dry-run
MOSS_COMPILED_BUNDLE=/tmp/rust-release/compiled_bundle.rs \
  cargo +1.95.0 build --locked --manifest-path rust-spike/module-publisher/Cargo.toml \
  --bin moss-bundle-bootstrap
```

The runner discovers all Rust first-party manifests and invokes their existing package builders,
component encoders and UI builds. Guest builds have separate target folders. Rust source,
registry, toolchain and build paths are remapped before compiling Wasm. The Linux, macOS and
Windows CI jobs compare the complete package set and every unsigned `.mosspkg` digest; a mismatch
stops publication. Their CI artifacts carry unsigned packages and digest reports between jobs.
They do not publish a GitHub release or retain private signing keys.

`moss release` generates a temporary key for `--dry-run`. Production mode reads only
`MOSS_RUST_REGISTRY_SIGNING_KEY_ID` and `MOSS_RUST_REGISTRY_SIGNING_PRIVATE_KEY` (base64 PKCS#8).
Those secrets are not provisioned by this task. Missing values stop manual dispatch explicitly;
pushes and pull requests use generated keys. The TypeScript signing key is never used.

A first manual run without an approved report prints the public digest/capability/fetch-host
review and refuses publication. After inspecting it, dispatch again with its exact report digest
in `approved_report`. Package or prior-index changes invalidate that approval. The release owner
signs digest-bound approval artifacts through the existing Moss publish-review policy; this is
separate from each installation's permission approval. Unchanged packages retain their bytes.
Previous signed history and revocations are verified with part 4's mirror before being retained.
A refresh advances the serial and expiry; neither an expired snapshot nor an omitted historical
version resets history. Publication cannot silently replace an existing version's bytes.

## Publication unit

GitHub release assets cannot represent the host's nested `packages/` URL layout directly.
The downloadable registry is therefore a complete folder snapshot in `registry.zip`, suitable
for extraction and part 4's verify/mirror commands. This is a release artifact, not a configured
HTTPS registry endpoint or a production deployment.

Publication serializes the full previous-snapshot read, build and swap. It uploads immutable
digest-named packages and detached signatures first. The complete archive, including the signed
index, swaps last as one asset. Readers use that one complete archive, so metadata and packages
remain from the same snapshot; failed earlier uploads leave the old archive available. Old package
assets remain available. The Linux stand-in is uploaded under its executable digest before the snapshot.
GitHub replaces the archive using `--clobber`, which can briefly make it unavailable;
this is not an atomic availability guarantee. Only manual dispatch from main may publish.

## Stand-in contract

`compiled_bundle.rs` embeds the public first-party key, registry identity, selected digests,
publisher signatures, default/optional choices and package bytes into `moss-bundle-bootstrap`.
The bootstrap reads no downloaded allowlist and no index, so even a past-expiry index cannot
prevent a fresh offline bootstrap. It authenticates every package and reuses host compatibility,
archive, SQL and component-import checks. Default packages install in dependency order through
the existing lifecycle. Optional packages enter the blob store without activation.

The default set is exactly the manifests with `lifecycle.required: true`. Manifests without that
field are optional. Every first-party package is carried in the bundle; Finance and Meals are
optional, and Finance's lifecycle declaration now reflects that it is bundled. No module is
made required by the release script. People still declares the existing `person-providers`
dependency; bundling its bytes does not manufacture that missing package or bypass dependencies.

The file-only stand-in supports no-SQL/no-job fixtures:

```sh
moss-bundle-bootstrap fresh-data-folder ADMIN_UUID
```

For real first-party packages, provision an isolated host database/schema and admin first, then
supply `MOSS_BUNDLE_APP_URL` and `MOSS_BUNDLE_MIGRATIONS_URL` by secret name through the normal
host/gate setup, and pass `--postgres`. It uses the real Postgres catalog and transactional
migration/queue lifecycle. It does not provision accounts, database roles or schemas. File mode
refuses SQL and scheduled modules rather than pretending to install them. Phase 7 consumes this
bundle contract while supplying real setup and installer UX.

Bootstrap cannot replace an existing module or run after any registry observation. Interrupted
bootstrap resumes only an already active compiled digest signed by the same key. Once a registry
is reached, ordinary index expiry, revocation, update consent, pins and quiet-time policy apply.

## Focused gate

```sh
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/rust-release-gate \
  pnpm test:rust-phase6-offline-bundle
```

This gate uses generated signed fixtures, an expired index and the real host. Linux executable
proof denies socket creation for the bootstrap child, verifies that the denial works, and checks
that defaults activate while optional Finance/Meals remain cached. The online fixture uses a
signed folder registry, tests newer versions, quiet time, pins and urgent access/migration growth,
and preserves a planted account value. It makes no claim about public GitHub availability.
Guard-removal controls restore source in `finally` and require assertion failures, then rerun the
restored focused suite. Never run them alongside another Cargo build.
