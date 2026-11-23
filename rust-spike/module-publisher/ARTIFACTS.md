# Shared package and registry artifacts

The `moss` binary in this crate shares the host's archive, manifest, signature, publisher binding
and catalog readers. It does not replace the per-module packers or their manifests. Build each
module with its existing packer; its `.mosspkg` output can enter the signed registry unchanged.
For a prepared directory in the standard archive layout, `pack` provides the same shared writer.

```sh
moss pack prepared-directory output.mosspkg
moss inspect output.mosspkg
moss verify pipeline.json submission.json
moss registry assemble pipeline.json selection.json index.pk8 output-folder
moss registry verify pipeline.json [other-pipeline.json ...]
moss registry mirror pipeline.json output-folder [other-pipeline.json ...]
```

`pipeline.json` and `submission.json` use the existing publisher configuration and submission
contracts in README.md. `inspect` reports structural validity and the original manifest; it does
not authenticate a publisher. `verify` authenticates against the configured root and publisher
binding, then checks host compatibility, SQL and component imports. It does not require that the
candidate version is newer than the registry history; publication review still belongs to the
`moss-module-publisher review/publish` commands.

Registry assembly consumes an **already signed** registry folder: `registry.json` and its root
signature, `index.json` and its index-key signature, and all digest-named package files with their
publisher signatures. Stage the exact signed index string returned by part 3's publish command;
do not reserialize it. Root identity provisioning remains a release-owner responsibility. Assembly
validates the layout and adds a signed `bundle.json`, without changing any existing signed bytes.
The supplied PKCS#8 key must match the index's authorized signing key. Inputs and outputs must be
separate; output folders must not exist; their parent must exist. Assembly also refuses inputs
that already contain a signed bundle. This avoids overwriting immutable blobs or a published
version. Atomic deployment and concurrent publication serialization belong to part 5.

Selection uses the existing additive module-list contract twice:

```json
{
  "default": { "modules": [{ "id": "tasks", "registry": "moss", "version": "1.0.0" }] },
  "optional": { "modules": [{ "id": "finance", "registry": "moss", "version": "1.0.0" }] }
}
```

A null or omitted version selects the greatest stable version. Each id may occur once across both
lists. Every selection must name this registry and an available, unblocked package. The release
owner derives the two lists from module lifecycle declarations; this tool does not invent module
defaults. Finance and Meals belong in the optional list for first-party release bundles.

`bundle.json` binds registry identity, index digest and serial, and resolved default/optional
module versions, digests and publisher signatures. `bundle.json.sig` authenticates its exact bytes
with the index signing key. A release builder can compile the selected digest list into the
installer; this command does not implement installer bootstrap or grant an expired-index exception.
Registry verification and assembly require a current index. Mirroring preserves an expired signed
snapshot too; it does not make that snapshot usable for new installs.

Mirroring checks the signed metadata, archive digests and detached signatures before copying.
It preserves bytes, including signature whitespace, bundle files and digest-named media. Additional
pipeline configurations check cross-registry publisher conflicts; they are not merged into the
output. No command changes an existing output folder. Media files with names outside the digest
layout are refused, including temporary files. Verified package and media bytes are currently held
in memory; memory use grows with registry history. Streaming large histories is deferred. Folder
sources only are supported by this release's CLI; the host retains its existing HTTPS registry client.

These are build/release tools with no new Moss screen or setting. The legacy TypeScript registry
workflow remains unchanged.

## Focused verification

Run from `~/Jarv1s`, with one Cargo build at a time:

```sh
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/moss-registry-artifacts \
  pnpm test:rust-phase6-registry-artifacts
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/moss-registry-artifacts \
  python3 rust-spike/module-publisher/tools/artifacts-negative-controls.py
```

The second command temporarily removes one protection at a time, requires a real test assertion
failure, restores source bytes in `finally`, and reruns the suite. Never edit/build concurrently.
Generated test keys exist only in temporary fixture folders. No production keys are needed.
Cross-OS digest comparison and installer bootstrap proof are part 5, not established by this gate.
