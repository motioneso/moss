# Root-pinned Computer closure signer publication

Task #3664; part of #3618/#3617/#3616/#3577, with #3619 open. Approved design:
persistent-desktop spec24–27. Base `6cffffed4baaafa5b333992a98eadc4803d6bbf2`, actual
PR3663 merge; final HEAD `66387118ce0704863136b61c89291bb7bd949d0b`. Fresh connected
GitHub reads confirm this merge and successful CI40118605128 at final HEAD. Initial local
Git inspection independently confirms ordered parents8786e0a3/66387118, tree9c4b1c43,
all9 PR entries, zero concurrent-main entries and separately full-tree equality to final HEAD.
The retained independent actual-merge reports and comment6387992068 accept this exact merge.

Follow the complete [closure provenance dispatch](../handoffs/2026-10-24-moss-computer-closure-provenance.md)
and inherited gates through actual owner delivery. This phase implements signer installation
tooling and its actual closure-loader consumption. It does not execute a real installation,
Computer image/runtime operation, product wiring, admission or deployment. Keep unavailableAdmission
unchanged and every owner parent OPEN. A prerequisite never completes owner delivery.

## Seams and bounded decision

Graph tools and local codegraph are unavailable in this session; bounded current-source reads:

- `scripts/computer-closure/config.ts:95–175` validates root code/config/key/namespace and a
  configured Ed25519 SPKI pin, but has no signer publisher or independently pinned installation
  input. It loads after stop and must not regain a live-runner/heartbeat requirement.
- `scripts/computer-closure/config.ts:192–206` reloads configuration and key and compares
  metadata/bytes. Extend this actual consumer with installation-file equality and native Node hash.
- `scripts/computer-closure/receipt.ts:76–99` signs bounded records with that loaded key and includes
  config/artifact/public-key hashes. Binding the new installation through the config hash preserves
  existing signature semantics; no receipt key is allowed to establish its own authority.
- `scripts/computer-watchdog/trust.ts:69–146,150–198,224–237` supplies exact supervisor parsing,
  strict root ancestry, bounded NOFOLLOW reads and independent boot/pid/mnt/user/uid-map anchors.
- `scripts/computer-provision/publication.ts:24–139` provides exclusive descriptor-pinned
  publication, file+directory fsync, close and inode/metadata/byte readback. Reuse this canonical
  mechanism for two fixed new names; do not build a second publisher.
- `scripts/computer-capture/run.ts:18–123` samples actual managed processes under its SAME store
  and sole lifecycle lock. It is not final descendant reconciliation or a closure configuration
  publisher; do not turn capture.json into complete closure authority.
- `scripts/computer-host/operations.ts:97–105` creates/saves/starts each role in sequence, whereas
  PREPARE requires BOTH durable IDs. `docker.ts:206–234` separates never-started and running-pair
  observations. Existing-resource lifetime health cannot satisfy health BEFORE launch.

Choose a root signer publisher plus mandatory actual verifier consumption as ONE bounded contract.
Generating a key inside the verifier would let each receipt select its own authority. Publishing
the entire per-run closure configuration now would also cross live managed capture, final
descendant reconciliation and launch ordering. Those need separate accepted contracts. This
publisher installs the private signer and manifest, pins existing trusted code/Node in place,
and does not copy/claim to install executable code. No authority from an injectable success
predicate, fixture receipt, manifest existence or a self-supplied public key.

## Request, authority and publication

New modules `scripts/computer-signing/config.ts`, `installation.ts`, `run.ts` and composition root
`scripts/computer-signing.ts`. Focused tests/fixtures under `tests/unit/computer-signing-*`.
Modify only canonical publication and closure config/loader plus affected existing fixtures.
No dependency, HostConfig, product/app-map, required deployment setting or default changes.

`computer-signing <trusted-request>` uses root-only Linux/builtin CJS and absolute native Node.
One absolute60s native timer starts before any startup I/O; TERM/INT latch failure without renewing
it. Equality refuses success. Empty stdout/stderr, exit2 on failure, exit0 only after final durable
publication/readback/close and revalidation. No retries, overwrite, reset, cleanup or lock acquisition.
No HostStateStore, Docker connection/mutation, process creation, lifecycle authority or runtime claim.

Closed request fields: `artifactSha256`, `supervisor`, `closureArtifactPath`,
`closureArtifactSha256`, `nodeSha256`, `netNamespace`, `output`. Existing supervisor parser
canonicalizes the template; lifetime must be ABSENT (no shared receiver secret in this input).
Capture is allowed as a trusted template root, but no process capture happens. Root template
contains the existing configured run/runner/host/roots/boot/namespaces; this tool does not claim
runner liveness, heartbeat, healthy observation or installed runtime suitability.

The separately committed independently accepted installation/run packet must supply the exact
request and independently verified installer/closure artifact and native Node hashes and
boot/pid/mnt/user/net anchors. Reading self/PID1 to invent expected anchors is not a substitute.
The request is private0600 single-link <=16KiB, in root0700 canonical trusted ancestry. Verify
installer artifact hash <=2MiB and closure artifact hash <=2MiB, native Node hash <=128MiB, their
root-owned nonwritable ancestry/metadata and the configured anchors before publication and again
after awaited work. Self and PID1 net links must both equal the request, alongside canonical
existing namespace/boot/uid-map checks. Pin input inode/bytes and all code/Node metadata+hashes.

Output is a pre-existing pinned root-owned0700 RootIdentity with trusted ancestry and starts empty.
Inspect actual host roots plus data/dockerData/monitor and optional capture; output must have no
overlap in EITHER direction with any of them. Request, installer, verifier and Node stay outside
output and those roots. Do not mkdir/chown an installation directory or alter existing code.
Require all configured roots/trust to remain stable. Host roots retain inspectRoots permissions and
pinned assertRoot identities: guest UID1000 writable home/socket roots are valid under root-controlled
ancestry. Strict assertTrustedPath applies to trusted data/docker/monitor/capture/output roots,
not guest-writable mount targets. A root operator supplies the trust root;
the generated manifest cannot attest that operator or replace independent installed acceptance.

Generate one native Ed25519 key pair. Exclusively publish `output/closure-key.pem` (PKCS8 PEM,
root0600 <=4096bytes) and then `output/installation.json` (root0600 <=16KiB). Extend the fixed
canonical publication name set with these names and support raw Buffer bytes only for the PEM
name; existing JSON paths/limits remain unchanged. Reuse all actual fsync/close/readback behavior.
Never print private key/config bodies or errors; only key-derived SPKI SHA256 enters the manifest.

Closed installation schema: version1, kind=`closure-signing-installation`, inputSha256,
installerArtifactSha256, supervisorSha256 (canonical parsed template WITHOUT lifetime),
artifactPath, artifactSha256, nodePath, nodeSha256, bootId, namespaces (pid/mnt/user/net),
output (RootIdentity), signingKeyPath, publicKeySha256. Exact key path is output/closure-key.pem;
manifest path is output/installation.json. No lifetime secret, process command line or key bytes.
Pin template hash so a signer installation cannot silently transfer to another run/host/runner/root
configuration. Persist file+directory and close EACH file before the next publication; recheck
both outputs, original request, roots/namespace/code/Node and deadline after all awaits/closes.
The manifest is a delivery record, never a native completion or admission acknowledgement.
Any failure retains all partial files and never deletes keys/evidence. Retry finds nonempty output
and refuses; there is no successful-looking replacement completion file.

## Mandatory actual closure consumer

Extend the exact ClosureConfiguration schema with required `installationPath` and
`installationSha256`. This opt-in tool has no qualified installed configuration to migrate;
old unbound closure configs must refuse rather than silently bypass provenance. Update all
affected closure/native fixtures to install using the actual publisher. No legacy success branch.

Actual loadClosureDeployment reads the pinned private installation file through closureFile,
requires its configured hash and closed schema, and checks original boot/pid/mnt/user/net,
supervisor-template hash, exact verifier artifact path/hash, actual Node path/hash, exact key path
and derived public-key hash. Validate the manifest's output RootIdentity and trusted0700 parent;
require installation/key to be its fixed children. The key, manifest and output must stay outside
all configured host/data/docker/monitor/capture AND receipt roots, with overlap rejected both ways
for the output. Continue existing verifier socket/root/process checks. Do not open a lifecycle lock
or require any runner/guest process alive after stop.

ClosureDeployment retains the installation file snapshot. Revalidation repeats installation
inode/bytes/hash, output identity, code/Node hash+metadata, key/config and namespace checks at
the actual existing pre/post-observation and final native-success boundaries. Signed records bind
the configured installation hash transitively through configSha256. A later independently accepted
run packet must pin this exact installation hash AND public key; neither signature nor manifest
alone proves trusted installation, descendant completeness or native completion. Per-run closure
configuration delivery/binding and final descendant reconciliation remain implementation work.

## Verification, kill gate and continuation

Kill owner computer-closure-provenance: split/reject if this needs actual runtime, additional lock,
fabricated process tuples, successful admission, relaxed trust, key exposure or sampled-complete
closure. Evaluate this one phase before planning final reconciliation or prelaunch in detail.
No UI/model calls; later feedback comes from records, models propose authorized tasks/input only.
Dependencies/cache inspected; scoped frozen offline root/API/worker/web/spike/workspace install.

Execute actual publisher-to-closure-loader composition over temporary files, actual crypto and
descriptor/fsync/readback, with explicitly disclosed root/runtime/namespace/code provenance
projections where necessary. Such fixtures do NOT establish installed root trust or real Node24/
image/128MiB qualification. Native production CJS nonroot refusal must silently exit2. Native
projected positive composition records actual argv/UID/Node/artifact, streams and successful
completion; held file and directory fsync plus repeated signals must fail within one original
absolute timer (scaled fixture timer disclosed). Test safety SIGKILL cannot satisfy native exit2.

Behavior: exact trusted publication and actual mandatory loader consumption; reject absent/extra
fields, wrong hash/key/namespace/template/run/root/code/Node, unsafe/symlink/hardlink/FIFO/oversize
input or output, overlap/foreign output, pre-existing files, replacement after close, failed/held
file/directory fsync/close, deadline equality and interruption after awaited work. Preserve partial
files and never touch state/stop/lock/home or Docker. Inspect secret path through builtin crypto,
the PEM publication and existing receipt signer; public evidence excludes keys/private paths.
Observe intended executable assertion failures for each claimed new protection removed; retain
patches/logs and failed rounds, restore byte-for-byte, then run the final green batch.

Unpiped expected0: focused signing and all affected Computer suites; `pnpm exec tsc --noEmit`;
`pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint zero warnings/Prettier;
`pnpm check:file-size`; `git diff --check`; builtin-only signing/watchdog/host/provision/closure CJS
bundles and `pnpm build:computer-gateway <new-private-output>`. No DB/foundation, actual installation,
Computer image/runtime/Docker, browser or TCP server operation. Evidence binds source/artifacts,
exact commands/exits/logs, controls, restored bytes and fixture limits, with failed rounds retained.

Commit this exact plan; independent read-only Security+Standards/Spec acceptance BEFORE code.
Then independent exact source review/corrections, exact local-evidence acceptance, final-HEAD
required green CI and supplemental acceptance precede protected actual merge. Verify ordered
parents/tree/all PR and concurrent-main entries, then verify a fresh isolated successor's actual
native UUID, durable routing and preserved acknowledgement. Leave a clean pushed tree and owned
resources closed. Historical private siblings stay read-only. Preserve every inherited runtime
gate, accepted r21 and unknown r12/r18 causes. Installed qualification, descendant reconciliation,
prelaunch health, new-run/reset/uncertain-create quiescence, actual Node24/128MiB/TigerVNC/fixed
lifecycle, API leases/dispatch and real owner HTTPS/WSS/chat/hostile live acceptance remain gated.
No production deployment. A prerequisite never finishes actual owner integration.

## Source-review correction R1

Both independent reviewers found blanket strict-root ancestry checks on host mount targets would
reject the existing UID1000 desktop home/socket contract. Retain canonical inspectRoots checks
and pinned assertRoot identities for host roots; do not force guest mount targets to UID0.
Strict root trust remains on private configuration/code/key/output and supervisor trusted roots.
Add actual publisher/loader coverage with projected UID1000 home/socket, and unsafe host ancestry
and replacement rejection. This corrects composition without relaxing installation authority.
