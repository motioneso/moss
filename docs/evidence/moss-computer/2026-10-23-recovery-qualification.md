# #3578: recovery qualification preflight

- **Result:** BLOCKED_MISSING_PINNED_CANDIDATE. Recovery runtime NOT_RUN.
- **Authority:** Ben dispatched the bounded recovery packet with “proceed”; full autonomous
  implementation authority persists. This is an artifact/readiness blocker, not a permission request.
- **Operator:** Codex `/root`. Independent reviewer: `/root/independent_review2`, no authorship.
- **Dispatched source:** `db3d135ab1fc9fd68405db62db270199c6b07219`.
- **Packet:** [Recovery qualification](../../superpowers/plans/2026-10-23-moss-computer-recovery-qualification.md).
- **Receipt:** [Sanitised preflight](2026-10-23-recovery-preflight.json).

## Coordinator decision and evidence

Do not replace the pinned image silently or run the recovery script against another candidate.
Stop this attempt at failed preflight. The earlier [partial qualification](2026-10-23-isolated-qualification.md)
and [runtime receipt](2026-10-23-runtime-receipt.json) remain historical evidence for their exact image.

| Evidence class      | Finding                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-supported    | All seven candidate file hashes still match the accepted runtime receipt. The Dockerfile pins its Debian base and Websockify wheel, but resolves mutable apt inputs. Same source does not establish the same image.                     |
| Deployment-observed | Docker's current default context on the selected server reports the required image `sha256:5516b80402f9f4122a8551c6417c197356d73808ddfcf4b78f664c10c1e56c3a` absent. No proof containers exist. Production Moss is running and healthy. |
| Historical          | The earlier trial passed normal viewing/input and replacement persistence; crash transport reconnected before the rendering assertion timed out. Recovered input was not reached.                                                       |
| Unknown             | Why the image disappeared; whether any unexamined cache/archive could restore it; the cause of the earlier rendering failure.                                                                                                           |
| Not run             | New image build, restored desktop, crash/reconnect, fresh recovered input and runtime resource sampling.                                                                                                                                |

Fresh headroom snapshot: 19,510 MiB available RAM, 13,527 MiB root free and 987,246 MiB data-filesystem
free; swap substantially used. This is a preflight snapshot, not a benchmark. A port reservation
was acquired and released; no listener, containers, network, certificates or supervisor were created.
Prior synthetic home/profile and source evidence were preserved. No production files or services changed.

Image listing and bounded build-cache description inspection did not identify a Computer artifact.
No exhaustive cache search or restoration is claimed. A proposed `--network=none --pull=false`
build was rejected as a cache-only guarantee: it does not prevent all metadata/base resolution.
No such build ran. Do not attribute image loss to pruning without evidence.

The diagnosing-bugs loop could not be started against its pinned runtime. No new root-cause
hypothesis, fix, regression result or recovery acceptance follows from this preflight.

## One proposed next assignment: reconstruct one candidate and decide adoption

This is a separate bounded checkpoint, not dispatched by this report. Use existing task #3578,
parent #3577 and the same selected server; no substitute machine or production storage. Preserve
the provider-agnostic offline desktop design and all prior evidence. No AI/provider call is needed.

Codex `/root` owns only `spikes/moss-computer/*` and its spec/plan/evidence. An independent reviewer
must judge the exact artifact and may reject it; no shared auth, AppShell, Sports, installer,
production packaging or roadmap-progress changes. Existing guide dependencies remain as mapped
in the recovery packet; this checkpoint completes no guide task or stage by itself.

Before building, commit an amended candidate packet. First examine any specifically identified
existing archive/cache reference. If the exact image cannot be restored, explicitly name a rebuilt
image as a new candidate. Reuse the current stack/source; do not silently update the viewer or relax
security. Record build inputs, finite build exit, resulting immutable image ID, source hashes and
complete installed-package/Websockify inventories. Compare them with the retained original
inventories, disclose every difference and obtain independent adoption/readiness review. A failed
build stops for diagnosis; two identical failures require a scope decision.

The checkpoint permits only a bounded image build and metadata/filesystem inspection. It launches
no desktop/viewer or product proof. Use the existing Docker data filesystem after fresh headroom
checks; actively attend with a named build finish operator, Codex `/root`, a finite 30-minute build
deadline and cancellation/child-process verification. Do not prune shared images/cache to make
space. If the builder cannot be bounded safely, stop before build. Keep build logs private/bounded;
publish only sanitised receipts. Preserve an adopted candidate under a task-specific tag and a
checksummed archive in designated private proof storage; record retention so the same failure is
less likely to recur. Delete only checkpoint-owned temporary build/output files; preserve prior home.

Return one exact-candidate adoption/rejection verdict and stop before recovery runtime. An adopted
candidate then needs its own amended recovery dispatch/readiness review, with substantive baseline
frame/input and affected security checks before crash/reconnect testing. Prior runtime results do
not automatically transfer to a rebuilt image. Actual persistence, Moss ownership/session routes,
remote manual viewing, Internet access and release gates retain their own evidence requirements.

## Independent review

Preflight reviewer `/root/independent_review2` independently returned
**BLOCKED_MISSING_PINNED_CANDIDATE; no runtime should launch.** It confirmed source hashes still
match the accepted receipt, distinguished mutable rebuilds from restoration, and rejected the
cache-only command guarantee. Final exact-document review is recorded separately in the
[review ledger](2026-10-23-independent-review.md). Neither verdict qualifies recovery or makes
PR3579 merge-ready. Task #3578 and parent #3577 remain open.
