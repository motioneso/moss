# Workshop host control (R1d / #2293)

Optional Linux amd64 host transport for the public image in `../workshop/README.md`.
**Workshop execution remains unavailable.** R1e must connect the worker to this transport after
settings-owned approval/revision/attempt/lease authority exists. No installer or shared service
was run for this slice. A locally passing transport is not a deployed Workshop acceptance result.

## Ownership and lifetime

The existing UID 1000 deployment account owns the controller and already has Docker access.
Installation does not grant the app Docker access or new host privileges. Its existing user
systemd manager must have lingering enabled; the installer checks this and does not enable it.
Python 3 stdlib and systemd supply the controller; no additional host package dependency.

The controller has one private Unix socket plus a 32-byte service authentication key in the
control directory (0700 directory, 0600 files/socket). Only that directory is exposed to the
trusted app. The host-only journal and controller configuration live in a separate 0700 directory.
No private app data, credentials, sockets, or host directories enter generated execution units.

A consumed run reference is atomically persisted before dispatch. Each run gets an independent
transient unit with a fixed 60-second `RuntimeMaxSec`, five-second stop timeout, `KillMode=control-group`
and `ExecStopPost=docker rm -f <exact-owned-name>`. The helper has its own 55-second streaming deadline.
Killing the controller does not kill the unit's independent deadline; even a stopped helper is
terminated and its container removed by systemd. Parent controller restart preserves consumed IDs.
The resource journal records transport identity/results only; it is not an application attempt repository.

Fixed recipes and profiles match the R1c image proof: build uses 192 MiB/no swap, 64 PIDs and
0.25 CPU; render uses 512 MiB/no swap, 128 PIDs and 0.5 CPU. Both use UID/GID 1000, network none,
readonly root, all capabilities dropped, no-new-privileges, default seccomp, no Docker logs,
256 file descriptors, and a private 64 MiB noexec/nosuid/nodev workspace tmpfs. No caller can
choose image, command, environment, mounts, paths, limits or Docker options. The image must already
exist locally under an immutable sha256 ID; the launch never pulls an image.

## Protocol v1

One newline-terminated JSON request and response per Unix connection. The controller reads at most
240,000 wire bytes with a three-second socket timeout. Requests are serial; execution is independent.
The outer object has exactly `payload` (standard base64 of UTF-8 JSON bytes) and `mac` (lowercase
HMAC-SHA256 hex of those exact decoded bytes, using the service key). JSON key order is irrelevant
to verification because the signature covers the original bytes; no cross-language canonicalizer
is required. Never log the key, signed payload, source or proposal.

The decoded request has exactly:

- `op`: `start`, `status`, `stop`, or `result`.
- `expires`: integer Unix seconds, strictly in the future and at most 60 seconds ahead.
- `reference`: exactly `run`, `actor`, `project`, `revision`, `attempt`, `lease`, `sourceHash`, `recipe`.
  The first six IDs are lowercase UUID hex without hyphens (32 characters). `sourceHash` is SHA-256
  hex of the exact decoded source bytes; `recipe` is `build` or `render`.
- `source`: standard base64 source-envelope JSON for `start`; `null` for other operations.
  Decoded size is 1–131,072 bytes. The controller verifies the hash and treats these bytes as data.
  R1a and the isolated image validate source paths/content; the controller never writes those paths.

The key authenticates a **trusted service assertion**, not a user's login or a live application lease.
The future worker caller must load actor-scoped durable authority before signing, expire/invalidate
that authority before stop, and recheck it before consuming a result. Possession of the service key
cannot substitute for these checks. Existing service-wide CLI credentials are unrelated and are
never used as this key. Signed expired requests fail; an unexpired replayed start cannot launch twice.
A newly signed request with a changed owner, lease, revision, recipe or source hash cannot access an
existing run. R1e still owns application-level stale-lease rejection and exactly-once side effects.

Successful replies have `ok:true`, `state`, and the exact reference. `accepted` acknowledges only
manager submission. Status is `running`, `stopping`, `stopped`, `exited`, `failed`, or `recovery-needed`.
Terminal status is recorded only after both manager termination and verified container absence.
A crashed/killed helper without an exit marker remains `recovery-needed`; authenticated `stop`
reaps that exact unit and proves absence before returning `stopped`. Failed/unknown teardown never
reports stopped. A result request in `exited` returns `proposal`, base64 of at most 2 MiB stdout.
The helper independently bounds stderr to 64 KiB and kills on stream overflow. Raw diagnostics
are discarded. **Proposal bytes remain untrusted**; R1e/V1 must parse and revalidate bounded artifacts,
source/lease authority, and decode/re-encode raster previews before acceptance. Nothing is imported
or executed on the host. A stopped run never returns a proposal.

Failure replies contain only `ok:false` and `denied`, `already-started`, `busy`, `journal-full`, or
`control-unavailable`. Lost launch acknowledgements consume the run ID; retry is not another launch.
Two unresolved/live runs are admitted at once; 1024 lifetime claims cap a deployment journal.
Terminal markers make admission scans local file reads for completed runs. Never delete claims to
free capacity or reinstall with a fresh journal to bypass replay fences. Capacity expansion requires
an explicit retention design. Unique atomic-write temporary files cannot block retry after a crash;
incomplete claim directories are never dispatched. Their private abandoned files may be cleaned
by the deployment owner while the controller is stopped. Keep every 32-hex consumed run directory.

## Optional installation and Compose settings

Installation is a separate deployment gate. Before installing, review the pinned image, run the
private proof below, ensure the account already has Docker access and a lingering user manager,
and choose canonical absolute private directories. Do not put the journal under the app's dev
workspace mount. The installer refuses populated state, existing key/unit, and an active controller.
The control directory must already be 0700 if it exists (the checkout's placeholder starts at 0755).

Example after deployment approval, from `~/Jarv1s` (replace the image ID with the approved build):

```sh
chmod 700 infra/workshop-control
MOSS_WORKSHOP_CONTROL_DIR="$PWD/infra/workshop-control" \
MOSS_WORKSHOP_STATE_DIR="$HOME/.local/state/moss-workshop" \
MOSS_WORKSHOP_IMAGE=sha256:<approved-image-id> \
bash infra/host/install-workshop-unit.sh
```

The installer copies controller code/config into the private state directory and installs
`moss-workshop-control.service` in the account's user-unit directory. `Restart=on-failure` owns
controller recovery. It does not start the app, restart shared services, or enable Workshop builds.

Both Compose files have optional empty-default `MOSS_WORKSHOP_CONTROL_SOCKET` and
`MOSS_WORKSHOP_CONTROL_KEY_FILE`. The dev worker can address the existing workspace mount at
`/workspace/infra/workshop-control/control.sock` and `/workspace/infra/workshop-control/key`.
Production mounts `${MOSS_WORKSHOP_CONTROL_DIR:-./workshop-control}` read-only at
`/run/moss-workshop`; use `/run/moss-workshop/control.sock` and `/run/moss-workshop/key` there.
Native dev workers use the corresponding absolute host paths. Never mount the host-only state,
Docker socket or user bus. With empty settings or an absent service, the future caller must fail
closed; the current unconditional worker gate already does so before model dispatch. Moss startup
has no dependency on this optional service. These are transport settings, not an execution-enable flag.

## Updating controller code

Do not rerun the first-install script against an existing deployment. For a code-only update:

1. Stop `moss-workshop-control.service`. Read the existing config's fixed prefix and state directory.
2. Wait for every unit under that exact prefix to be inactive/failed and every Docker container with
   that exact `moss.workshop` label to be absent. Resolve failed teardown before continuing.
3. Keep the existing config/image, key, prefix and **entire journal**. Copy reviewed controller code
   to a new 0600 file beside the existing `controller.py`, then atomically rename it over that file.
4. Start the controller service; verify authenticated status and replay rejection against a retained
   completed run. Application execution remains gated independently.

Changing the image/protocol or retiring a journal requires its own release migration; this procedure
updates compatible controller code only. No automatic retention, key rotation or host installer
upgrade framework is introduced here.

## Automated checks and evidence

```sh
python3 -B infra/workshop/test-control.py
python3 -B infra/workshop/prove-control.py --image sha256:<approved-image-id>
```

The first command uses only temporary files and mocked installation commands. The second uses
uniquely named private containers/transient user units, actual controller code, and no installation.
`--transport-only` runs the render/binding/container-client checks without repeating lifecycle stress.

The proof covers a real compiled worker/web bundle and raster proposal, authenticated unprivileged
container caller, owner/lease/hash mismatches, expired/invalid requests, duplicate dispatch, exact
idempotent stop, direct container stdout flooding around recipe capture, controller death, frozen
helper, independent systemd timeout, peer survival, restart replay fencing and exact cleanup.
It does not prove live DB/RLS/credential ownership, worker integration, actual Compose deployment,
installed service lingering across host reboot, raster acceptance, or application stop/late-result semantics.

Final local evidence uses image
`sha256:dbf24bc666f3f966bfccac884b136198c85a33e96e035ca1e49c9288a19a5e1d`:
`/tmp/workshop-r1d-proof-03.log` passed the full proof and cleanup of all six owned run references
plus the private caller container. `/tmp/workshop-r1d-transport.log` passed the separate caller
check. `/tmp/workshop-r1d-unit.log` records six passing local tests. Standards and Spec reviews
rechecked the recovery fixes and reported no remaining blockers. Dev/prod Compose rendered with
synthetic settings and passed empty-default/read-only/no-Docker-mount assertions. No shared
service installation, restart, module installation, deployment or execution enablement occurred.
