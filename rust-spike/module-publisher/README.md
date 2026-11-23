# Module publish review

Internal publisher tooling for phase 6 part 3. It does not upload packages, deploy a registry,
manage release secrets or replace installation consent. It uses the host archive/manifest,
Wasmtime import, SQL, publisher-name and unchanged-migration checks.

Run from `~/Jarv1s`. The trusted pipeline configuration is a JSON file with:

- `registryPath`: staged folder containing root-signed `registry.json`, signed `index.json`,
  their `.sig` files, and the prior `packages/<digest>.mosspkg` blobs.
- `registryId`: expected registry identity, checked against the signed identity.
- `rootKey`, `firstPartyKey`: approved base64 Ed25519 public keys, not private keys.
- `mossVersion`: target host version.
- `policy`: `moss` requires human review on growth; `self-hosted` permits automatic publication.
- `reviewerKeys`: map from authorized human reviewer IDs to base64 Ed25519 public keys.

Keep this configuration under release-owner control. A submitter must never choose policy,
roots or reviewer keys. The candidate submission JSON has `packagePath`, `publisherKey` (the
signed identity's publisher alias), and `signature` (base64 publisher signature over the ASCII
SHA-256 package digest). Candidate package bytes are read once with the host size limit.

```bash
cargo run --locked --manifest-path rust-spike/module-publisher/Cargo.toml -- \
  review pipeline.json submission.json > review-request.json
```

The command authenticates the base registry and candidate, finds the greatest published version
of this module (across channels), checks that the version increases and old SQL stays unchanged,
and prints the computed request. A publisher is new when its actual public key has not signed
any artifact in this registry. An existing publisher's new module still requests approval for
its initial capabilities and fetch hosts. Permission growth uses the host's permission comparison,
including operation/resource/private-access and permission metadata changes. Fetch hosts are also
listed separately. Removals alone do not request human review.

An authorized human signs the request after inspecting the exact package and diff. The approval
JSON contains `request` (the complete request), `reviewer` and `signature`. Sign the bytes from
`moss_module_publisher::approval_bytes`: ASCII `moss-publish-review-v1` plus newline followed by
compact `serde_json::to_vec` of the typed `ReviewRequest`. Do not sign arbitrary input JSON:
whitespace and object ordering are not the canonical contract. The signature covers the registry,
base index digest, package digest, prior package digest, publisher alias/public key and diff.
The publisher CLI does not hold or generate human reviewer keys.

```bash
cargo run --locked --manifest-path rust-spike/module-publisher/Cargo.toml -- \
  publish pipeline.json submission.json /protected/index-key.pk8 approval.json > result.json
```

For a change needing no approval, omit the last argument. Any supplied approval is checked even
under self-hosted policy. The index signing key is raw Ed25519 PKCS#8 from protected pipeline
storage and must match the base index's authorized signing key. No private key belongs in this
repository. The CLI emits no publication bytes on refusal.

The result contains `index`, the **exact signed JSON string**, and `signature`, its detached
base64 signature. Preserve the UTF-8 bytes of that string when staging `index.json`; do not pretty
print or reserialize the parsed index. The index serial increases by one and expires seven days
from publication. `publishReviews[packageDigest]` carries the request/diff and optional human
approval inside the signed index. Keep the existing history and revocations. Part 4 owns archive
and registry artifact commands, and part 5 owns atomic staging/deployment and release custody.

The output is a proposal against one signed base. The release owner must serialize publications
and compare the current base digest before staging it; publishing two proposals from one base
must not overwrite one another. Changing the base requires a fresh review request/approval.

## Verification

```bash
RUSTUP_HOME="$HOME/.rustup" CARGO_TARGET_DIR=/tmp/moss-publisher-check \
  bash rust-spike/module-publisher/tools/check.sh
```

The registered runner is `pnpm test:rust-module-publisher`. It exercises the real CLI, Wasmtime
validation, archives and signed registry with temporary generated keys and no database/network.
Use only one cargo build at a time. Negative controls are described in the task proof report.
