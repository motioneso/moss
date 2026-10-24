# Trusted post-create Computer configuration delivery

Part of #3618/#3617/#3616/#3577. Pinned base `1a79c74b4cf4800740340617c67496f70fa762e1`,
actual PR #3651 merge. Its accepted final HEAD is `0d58a47cab177fb443612d14cc9289f6a3d71bd0`;
checked source `6ffe25c062c1e4ce96d3827d3ac207748b895815`. Fresh direct receipts reconcile
acceptances6385428467/6385612791 and successful run40102576836 attempt1/required gate120900930326
at that final HEAD, not the merge SHA. All12 published source hashes match. All16 closure files
match accepted HEAD; the five concurrent main documentation files match the first parent. Full
merge-tree equality to accepted HEAD is false. All five owner issues remain open.

Follow the complete [provisioning dispatch](../handoffs/2026-10-24-moss-computer-trusted-provisioning.md)
and its inherited contracts. This is internal opt-in tooling; no Computer runtime/image operation,
installation, launch admission, product wiring, deployment or persistence requalification.

## Seams and bounded decision

Graph MCP is offline; bounded current-source inspection supplied these citations:

- `scripts/computer-host/operations.ts:97-109`: current library creates, saves and starts each
  role in turn. `config.ts:7` orders gateway first. Both full IDs do not exist before that start.
- `apps/api/src/computer/lifetime-protocol.ts:11-58`: lifetime requires both full IDs, creation
  generations, request CAS, run and instance. Generate only from the exact durable pair.
- `scripts/computer-host/state.ts:99-151`: openExisting acquires the canonical exclusive lock,
  validates existing roots/state and never initializes missing state. Save fsyncs file+directory.
- `scripts/computer-host/docker.ts:74-171`: exact spec/inventory validation exists; initial
  known-ID inspect404 alone establishes absence. Add strict never-started-created observation.
- `scripts/computer-gateway/config.ts:13-29` and `private-endpoint.ts:5-24`: legacy config requires
  UID-owned0600/0700, so a root-owned0600 file is unreadable at gateway UID1000. Add a narrow
  root-owned0640/GID1000 config in root-owned0750/GID1000 directory mode; socket checks stay private.
- `infra/computer-gateway/Dockerfile:9`: actual image reads `/config/gateway.json`; fixed mounts
  in `scripts/computer-host/spec.ts:42-47` expose config read-only, never home to gateway.
- `scripts/computer-watchdog/trust.ts:254-346`: actual root supervisor loader validates private
  config, pinned Node/artifact/roots/namespace/runner and marker. Reuse it after root publication,
  collector=true (no heartbeat-pipe claim); later actual supervisor startup still checks its pipe.
- `scripts/computer-watchdog/managed-host.ts:66`: managed root owns the lifecycle lock while live.
  `scripts/computer-closure/config.ts:28-36` needs real watchdog/desktop/gateway host tuples;
  `docker.ts:135-139` does not capture those. They cannot be known before start.

First deliver a real stopped-pair publisher. It is independently invocable after actual create
and identity-save, before any start; it never calls create/start. A future launching composition
must create and durably save BOTH IDs, invoke this actual publisher, consume its durable result,
then start under separately accepted admission. Do not wire a successful injectable predicate.
The current launcher/executable admission remains unchanged and unavailable. Existing per-role
library tests are fixtures, not permission to use the old sequence for an installed run.

The alternative of adding preparation plus live capture plus launch now would cross bootstrap
admission and active managed-lock boundaries together. Capture remains concrete next work: either
inside the actual managed root under its existing lock, or an independent read-only snapshot
transaction that never acquires/steals that lock. Correlate repeated exact Docker State.Pid with
actual host /proc PID/start/group, and actual journal/native watchdog code/config identity; never
invent pre-start tuples. Container-init capture alone is not descendant coverage. Closure config
and signer/namespace provenance remain unpublished/unqualified here. Owner: provisioning successor.

## Actual publisher contract

Add `scripts/computer-provision.ts` and focused `scripts/computer-provision/` config/publication/run
modules, affected Docker read-only helper and narrow gateway config-loader change. Extend the
canonical HostStateStore.close with its existing mutation-guard contract for final lock release:
validate/close the descriptor before guarded final metadata/equality/deadline checks, then unlink
synchronously with no await after the last guard. Close/check failure retains the lock path; do
not recreate an already released lock. No dependency,
HostConfig field, app-map capability or dev/prod default changes. No socket-policy change.

`computer-provision <trusted-config>` is root-only Linux, builtin-only CJS, absolute native Node.
Anchor hrtime and one native absolute60s timer before startup I/O. TERM/INT latch failure; repeated
signals do not reset timers or restore admission. Reject at deadline equality. Silent exit2 on
failure, exit0 only after all persistence, close and exact final equality. No retries/reset/reopen.

Exact input fields: `artifactSha256`, `supervisor`, `supervisorArtifactPath`, `output`.
`supervisor` uses the existing SupervisorConfiguration parser, with lifetime ABSENT: no caller
may supply a successful binding/secret. `output` is a pinned RootIdentity, root-owned0700 in strict
root-owned nonwritable canonical ancestry, distinct and outside every host/data/docker/monitor
root. Supervisor artifact path is canonical/root-owned nonwritable; its hash must equal the
supervisor's pin. Input/artifact/Node trust uses the inherited runtime/path guards and bounded
NOFOLLOW|NONBLOCK reads. Input <=16KiB; artifacts <=2MiB. Pin config bytes/inode, artifact and
Node metadata+hash, namespace and roots throughout. Actual installation remains separately gated.

The existing gatewayConfigDir must already be root-owned0750/GID1000 with strict trusted ancestry;
do not mkdir/chown/migrate it. Dedicated root output starts empty. Source input and executable
artifacts stay outside output and all mounted/data/docker/monitor roots. No signing key is created.

Acquire only HostStateStore.openExisting. Refuse stop latch/stop.json, disabled or zero-generation
state, pending/missing/duplicate IDs, mismatched roots/marker/state, partial or foreign inventory.
Require exactly one durable gateway+desktop full ID and exact creation generations. Complete
exact Docker inventory must contain precisely both resources, each stopped with State.Status
`created`, Pid0 and StartedAt `0001-01-01T00:00:00Z` (or its zero fractional form). Running=false
alone is insufficient; a stopped prior run cannot be provisioned as a new run. Repeat exact
created-pair inventory and state/root/stop/config checks before completion. No Docker mutation.

Generate a fresh 32-byte random lifetime secret and binding using the configured run, instance,
current request CAS and both retained full IDs/creation generations. Construct actual gateway
config with owner, `/auth/auth.sock`, `/socket/viewer.sock`, `/ipc/gateway.sock`, and this lifetime;
validate via canonical parser. Construct supervisor config by adding the SAME lifetime to the
trusted template. Secret follows only these config bodies into existing gateway/root lifetime
consumers; outputs/receipts/errors contain no config bodies, secret or private error strings.

Publish exclusive `output/supervisor.json` root0600, then validate through the actual supervisor
loader. Publish exclusive `gatewayConfigDir/gateway.json` root0640/GID1000. Its directory is
root0750/GID1000 and is mounted read-only into gateway; UID1000 may read, cannot write it.
The gateway loader accepts this exact root delivery layout with strict root ancestry while
retaining its legacy private UID-owned0600/0700 mode for existing internal fixtures/tools.
It still rejects unsafe ownership, links/FIFOs/oversize/noncanonical paths and changed publication.

Use descriptor-pinned roots and exclusive NOFOLLOW|NONBLOCK opens. File+directory fsync and close
are mandatory for EACH publication; recheck root/path/inode/bytes/mode/link count after awaited
work. Never overwrite/unlink failed output or identity/stop/lock files. Before final success,
publish exclusive root0600 `output/prepared.json` containing only version/run/binding and
input/supervisor/gateway hashes, then fsync/close and revalidate every publication and input.
Its existence alone does not authorize launch: successful native completion plus independently
accepted runtime packet/admission remains required. Partial/failed outputs remain retained.

Release only this invocation's canonical lock on settled success. On any failure after acquiring
it retain the lock, exact state/IDs, partial config/evidence for explicit accepted recovery. Never
steal an existing lock or erase stop intent. Publication does not alter CAS/enabled/resources.

## Checks, kill gate and continuation

Kill owner: computer-trusted-provisioning. Reject scope requiring create/start, new-run/reset,
uncertain-create quiescence, lock takeover, API privileges or claiming fixture provenance. Phase1
ships alone; evaluate actual publisher before planning capture implementation. No UI/model calls;
later UI feedback comes from records and models propose only authorized tasks/input.

Cache inspected before scoped frozen offline root/API/worker/web/visual-chat+workspace install.
No DB/foundation, actual Docker/image/runtime, installation, TCP server or browser operation.
Tests disclose root/namespace/artifact/Docker/runner loader fixtures; actual files/fsync, exclusive
locks, Unix HTTP, config parser/readback and native executable refusal remain real. Test actual
publisher plus actual gateway/root consumer composition, not a mocked publisher returning success.

Behavior: exact stopped pair produces same binding in both consumers only after durable IDs;
deny pending/partial/foreign/running/stopped-prior/changed state/root/config/artifact/namespace,
existing output, unsafe gateway ownership, stop arrival, failed/held file and directory fsync,
deadline equality/signals, and changed output after close. Failed/partial outputs and lock survive;
no Docker mutation or CAS change occurs. Native CJS nonroot refusal must be silent exit2. Native
fixture composition and bounded held-I/O timer proof must clearly disclose trust substitutions.
Observe intended assertion failures with new claimed protections removed; retain patches/logs,
restore byte-for-byte then run final green batch. Retain every failed execution/review round.

Unpiped expected0: focused provisioning/gateway/host/managed/watchdog/closure behavior; root
`pnpm exec tsc --noEmit`; tests `pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint
zero warnings/Prettier; `pnpm check:file-size`; `git diff --check`; builtin-only CJS provisioning,
host/watchdog/closure bundles and gateway context build. Exact commands/hashes/exits in evidence.
Commit this contract; independent read-only security+Spec acceptance BEFORE implementation.
Then Standards+Spec/security source review/corrections, exact final local-evidence acceptance,
exact final HEAD required green CI and supplemental acceptance precede protected actual merge.

Verify actual merge and fresh isolated successor with actual UUID, durable routing and preserved
handoff-read acknowledgement. Carry complete provisioning dispatch through actual owner delivery.
Keep unavailableAdmission and all parent owner issues open. Reuse accepted r21; r12/r18 causes
unknown. Before ANY runtime/image operation separately commit/independently accept exact packet,
fresh healthy Moss/resources, independently alive watchdog AND first healthy sample, all inherited
1800s/90s/5s/gap<10s/age<5s/equality/log/home/identity/namespace/closure gates. Preserve exact guest
and gateway isolation/limits, API privilege separation, sole writer/auth/epochs/Fence/fresh leases,
actual Node24/128MiB/TigerVNC and real owner HTTPS/WSS/chat/live acceptance. No production deployment.
A merged prerequisite never finishes owner delivery.
