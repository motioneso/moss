# #3578: reconstruct one desktop candidate

**Dispatched:** Ben's “Please proceed here”, after the reviewed missing-image preflight.
Parent #3577; draft PR3579. Author/active finish operator: Codex `/root`; independent reviewer
`/root/independent_review2`. Full implementation authority persists. One outcome: adopt or reject
one precisely identified, retained image for a later recovery proof. Stop before desktop runtime.

## Inputs and ownership

Use the same selected Ubuntu/x86_64 server and existing isolated task worktree. The original
image is absent; its BuildKit history record retains configuration/provenance, not usable image
layers. No specifically identified archive exists. Do not claim restoration unless the immutable
image ID actually matches. Preserve previous home/profile and all historical receipts.

Source input is `d7e3d4efc2efe01d71fa52e552ac3c7f23daa906`, `spikes/moss-computer/*`, still matching
the earlier runtime receipt's hashes. Compare installed packages with the final prior inventory
`packages-r2.txt`, not the earlier `packages.txt`; compare upstream Websockify with `websockify-r2.txt`.
These private receipts remain on the selected host. Public evidence contains sanitised inventories,
hashes, differences and finite results, never host paths or generated credentials.

Codex owns only the Computer spike/spec/plan/evidence files. Shared auth, shell, Sports, production
packaging, installer and guide-progress work is not dispatched. No app-map capability changes:
this remains an internal offline candidate. No provider/model dependency or call is introduced.

## Bounded build and readiness

Commit this packet before build. Use the installed legacy Docker builder's explicit memory/CPU
limits, without changing the global builder or daemon. Its deprecation is disclosed; this is one
checkpoint, not a reusable tool. Fresh preflight must have at least 8 GiB available memory, 8 GiB
root free, and 30 GiB data-filesystem free. Do not prune shared cache/images to obtain headroom.
RUN-container cgroups do not cap the shared Docker daemon or base pulls. Monitor the actual Docker
root filesystem too; stop if it differs from the measured data filesystem. Record this limit.

Prepare a private run directory and temporary Dockerfile derived from the tracked original by
inserting exactly one `LABEL com.moss.build=<unique-run>` immediately after its pinned `FROM`.
This explicit metadata-only difference identifies inherited intermediate build containers. Retain
both recipe hashes and the derivation. No package/viewer/security changes are authorised by that
derivation. Build context contains only the candidate files, never user home or credentials.

Run `DOCKER_BUILDKIT=0 docker build` with 4 GiB memory and equal memory+swap, CPU quota200000 /
period100000, `--force-rm`, and the unique tag. Use normal build networking only for base/package
downloads; this does not change the desktop's later `network_mode: none`. No privileged helper,
Docker-socket guest mount, security-profile changes or real login/profile data.

First qualify these builder controls with one tiny, private diagnostic recipe using the already
installed immutable Redis image solely as a shell/base. `--network=none`; print actual cgroup
memory/CPU settings, then interrupt a sleep. Confirm the label is inherited, caps are observed,
the client terminates and all labelled diagnostic containers are removed. Preserve finite exit
and stop receipts. Remove checkpoint-owned probe intermediate images. A failed qualification
stops for diagnosis before the desktop build; two identical failures require a scope decision.

A separate run-scoped supervisor covers each build: maximum30 minutes, heartbeat90 seconds,
two-second headroom/log checks, 32 MiB build-log threshold and sampled10 GiB run-directory
threshold. These sampled storage thresholds are not quotas. No unattended timer-only completion.
Lost heartbeat, measurement failure, low headroom, deadline or operator stop terminates the client
process group and kills/removes only containers with the exact run label; verify closure repeatedly
before reporting success. Stopping and verification precede best-effort receipt writing. Never
stop a shared Docker daemon/builder or production service. If these controls cannot be qualified,
stop without building the desktop candidate.

## Candidate, comparison and retention

Build one desktop candidate; record source/derived-recipe hashes, exact base, command/options,
finite exit, resulting image ID and metadata. Create an explicitly named inspection container
without starting it, copy installed package/Websockify inventories, viewer source and entrypoint,
then remove it. This is filesystem/configuration evidence, not runtime proof. Check user, command,
entrypoint, default environment, option-check build results and source bytes. Disclose every
package/metadata difference; reject unexplained behavioural or security changes. Existing Compose
limits/isolation remain requirements, not re-proven facts for a new image.

Preserve a reviewed candidate with a task-specific local tag and a checksummed Docker archive in
designated private proof storage. Check archive configuration identity against image ID and list
layer contents without running the image; retain checksum and archive size. Do not claim mutable
apt inputs became reproducible. Build failure, changed packages or archive problems require an
explicit independent adoption/rejection decision, never a silent substitute.

## Review and attended finish

Independently review the exact build controls before launch and the exact source/image/receipts
afterward. Report failures and not-run cases separately. Confirm no labelled build or inspection
containers/client/watchdog remain and Moss is healthy. Preserve adopted archive/inventories, prior
home and sanitised evidence; remove checkpoint-owned temporary probe/output files only. Commit
and push reviewable work, leaving the task worktree clean. Keep #3578/#3577 open and PR3579 draft.

Stop at adoption/rejection. One later proposed assignment may amend recovery to the adopted image,
verify affected baseline/security cases and diagnose substantive post-crash rendering/fresh input.
No recovery, Moss integration, Internet browsing, human acceptance, installer or platform claim
starts automatically. Existing guide task mappings/gates remain unchanged.
