# Signed app update preflight (Phase 7, part 7)

This crate verifies an app update feed before the later updater can stop a server.
It provides a library and the `moss-app-update` command. It has no server-control,
download, staging, switching, rollback or screen code. The native artifacts in the
test release are this preflight tool, **not installers**. Installer inputs can use
the same release manifest once parts 13–15 produce them.

The crate compiles the module registry's canonical `trust_crypto.rs` directly so
both use the same Ed25519 signature and SHA-256 checks without making a small
client depend on the Wasm runtime. The registry's public API is unchanged.

## Format and trust

`index.json` is signed as exact bytes, with a detached base64 Ed25519 signature
in `index.json.sig`. Its fields are `serial`, RFC3339 `expires`, `signingKey`, and
`artifacts`. Each artifact declares `os` (`linux`, `macos`, `windows`), `arch`
(`x86_64`, `aarch64`), `version`, HTTPS `url`, lowercase SHA-256 `digest`, `size`,
and inclusive `schemaMin`/`schemaMax`. A target pair occurs at most once. An index
expires after seven days when assembled by this tool.

Trust comes from installed configuration, never from the feed. The public key
published with a test release is evidence for a deliberate test, not a trust
bootstrap mechanism. App-update trust is separate from module-registry trust.

The client authenticates the exact bytes, enforces the key ID, rejects expired
indexes and serial regression/equivocation, then selects the native OS and
architecture and checks the data schema range. `Artifact::verify_bytes` refuses
size or hash mismatches. It is the mandatory boundary for bytes provided by the
future downloader; a feed-only check cannot verify bytes it has not received.
The CLI accepts an optional local artifact to exercise that boundary now.

```sh
moss-app-update check FEED_DIR KEY_ID INSTALLED_PUBLIC_KEY_FILE SEEN_JSON SCHEMA [LOCAL_ARTIFACT]
```

Successful checks atomically replace `SEEN_JSON`, including the highest accepted
serial, index digest and pinned-key fingerprint. Refusals leave it unchanged.
Corrupt state fails closed. An exclusive directory lock prevents concurrent CLI
checks losing the highest serial. A crash can leave `.lock` or `.next` siblings:
after confirming no check is running, the owner can remove these temporary files;
keep `SEEN_JSON`. Library callers must provide equivalent serialization and durable
storage. Checks must use a trustworthy system clock. Key rotation is not implemented.

## Release

The JSON input is an array of objects with `os`, `arch`, `version`, `url`, `file`,
`schemaMin`, and `schemaMax`. `file` is a local build output. The tool hashes it,
signs the index, and verifies every target through the production client.

```sh
moss-app-update release INPUT_JSON NEW_OUTPUT_DIR SERIAL
```

By default a fresh throwaway key is generated in memory. Only `index.json`,
`index.json.sig` and `public-key.txt` are written. `--configured-key` instead reads
`MOSS_APP_UPDATE_SIGNING_KEY_ID` and `MOSS_APP_UPDATE_SIGNING_PRIVATE_KEY`
(base64 Ed25519 PKCS#8), and fails if either is missing. Never put a real key in a
file or command argument. Ben provisions the named GitHub secrets in part 17b.

`.github/workflows/rust-phase7-update-feed.yml` runs the refusal runner and seven
refusal guard-removal controls and a private-output control natively on Linux, macOS and Windows. Branch pushes and
manual dispatches assemble the native artifacts into an immutable prerelease
`rust-app-updates-test-<run>-<attempt>` in this repository. PR jobs have read-only
permissions and do not publish. Manual main dispatch can opt into the named
secrets without changing the workflow; throwaway signing needs no secrets. Test
releases do not overwrite a production channel. Actual app-feed publication with
real installer assets and production signing remains part 17b.

## Verification

Run sequentially, with `CARGO_BUILD_JOBS=1`, debug info off, one test thread, and
an isolated target folder (locally under the task's scratch directory):

```sh
cargo +1.95.0 test --locked --manifest-path rust-spike/app-update/Cargo.toml --test phase7_update_feed -- --nocapture --test-threads=1
python3 rust-spike/app-update/tools/negative-controls.py
```

The negative controls copy the sources to a temporary tree, remove each guard,
and require exit 101 at its named refusal assertion. Another control deliberately
writes a generated test private key into configured release output and requires
the output scan to fail. They never alter the working
tree. CI logs retain the exact unpiped command and its failing exit code.

The separate `test:rust-phase7-update-feed` gate builds the real Moss server,
starts it against a fresh gate database, creates an account, invokes the actual
update CLI for every refusal, and checks that the same server process still
serves that account after each one. Run it **only through `scripts/run-gate.sh`**
with task-owned `CARGO_HOME`, `CARGO_TARGET_DIR` and explicit `RUSTUP_HOME`; see
the repository's verify-gate skill. CI includes it in the host gate tier.
