# Independently executing Computer observation supervisor

Part of #3618/#3616/#3577; PR #3645. Base `81e2d112bb129eb146e6e80c18c9ad39861a45c2`
(merged measurement PR #3644). Exact source `071391eb209e2058c541ce7644bf2da747fff391`;
accepted amended plan `8b4cd25bad46359769f5b0084e9f0426bb8cbe52`.
[Machine-readable receipts](2026-10-24-trusted-supervisor.json) contain commands, exits, timings,
file/restoration/log hashes, artifact provenance and all retained review/attempt summaries.

## Result and boundary

An opt-in read-only observer validates trusted deployment/configuration metadata, composes
Linux measurements with actual sampled readiness/log metadata, and runs policy ticks separately
from a bounded collector child. Terminal state irreversibly starts owned-child termination and
ordered stop persistence independently, with one absolute five-second finalization deadline.
Failed persistence or unacknowledged child exit is failure; the journal and uncertain PID remain.
This is an observation-stop journal, not lifecycle stop/recovery or Computer resource closure.

Host unavailableAdmission remains unchanged. No launch, container mutation, receiving lifetime
fencing, product surface, deployment default or app-map capability is added. Installed root trust,
actual Node24 image/128MiB fit, TigerVNC, fixed lifecycle and owner HTTPS/WSS/chat remain gated.
Owner issues #3577/#3616/#3617/#3618/#3619 remain open. Accepted r21 persistence is reused without
requalification; original r12/r18 causes remain unknown. No production deployment.

## Executed checks and disclosure

On the restored exact source, **253 tests across nine files** passed: four new trust/journal/
observation/supervisor suites plus existing Linux/files/policy/host/client suites. Root TypeScript,
tests TypeScript, scoped ESLint with zero warnings, changed-file Prettier, file-size, whitespace
and builtin-only CJS esbuild checks exited0. File bytes matched HEAD before and after the batch.

Tests use actual temporary files, descriptors, Unix HTTP fixtures and ordinary native child
processes, including synchronous collector hangs, malformed/oversized output, held exit/identity,
held/failed fsync and repeated actual OS TERM. Root ownership/namespace and full Linux resource
composition use disclosed stand-ins; Docker HTTP and readiness responses are fixtures. They do
not establish an installed root deployment, live Moss readiness, real Docker inventory, sustained
resource fit or admission. Native child/fixture cleanup is exercised; no TCP server, browser,
DB/foundation check, image/runtime operation, root installation or production action occurred.

Final artifact: 60136 bytes, SHA256
`f615e927986eaefbdd121b15525bd04f3fdda64535d36c2a194d02c5d3cf43e5`.
All external imports are node: builtins. Its actual non-root invocation with a nonexistent config
exited2 silently in under one second. Build target is Node24; execution used Node `v22.22.2`.
This refuses bootstrap only and does not qualify the Node24 executable, image or installed service.
The earlier artifact belongs to source `f04cd45e4f333ac18a3a73aafd6a1c731979ecc3` and is
retained separately; it is not substituted for this final artifact.

## Observed removed-protection controls

Each final control exited1 at the intended assertion; source was restored byte-for-byte.

| Removed protection                           | Observed failure                                     |
| -------------------------------------------- | ---------------------------------------------------- |
| Namespace anchor comparison                  | Changed namespace resolved instead of rejecting      |
| Config byte comparison                       | Changed config resolved instead of rejecting         |
| Path-segment ancestry                        | Forbidden `..monitor` descendant accepted            |
| Earliest observation timestamp               | Returned3000 instead of original1000                 |
| Independent one-second tick                  | Zero owned-collector kill calls at5s                 |
| Terminal reentry guard pair                  | Stop persistence called twice instead of once        |
| Keep OS signal handlers through finalization | Child died by SIGTERM instead of normal finalization |
| Raw owned collector PID retention            | Stop call lost expected PID303                       |
| Actual log size bound                        | Exact-limit log accepted                             |
| Journal size bound                           | Exact-limit receipt accepted                         |
| Journal fsync                                | Failed durability resolved instead of rejecting      |

The initial terminal control removed only one redundant guard and passed; it proved nothing and
is retained as an unsuccessful control. The final paired-guard control observes duplicate stop
entry. Native double-TERM independently exercises Node's restored default signal behavior.

## Failed attempts and independent reviews

All private raw logs/reports remain outside ~/Jarv1s; JSON publishes only sanitized summaries and
hashes. Initial driver fake-clock timing failed and was corrected in the harness. Trust fixture
attempts failed because the inherited test-loader environment was rejected; the fixture now
explicitly removes it. Four retained TypeScript attempts exposed the same Stats/BigIntStats
signature error before narrowing to Stats; they are not counted as passing checks. Initial lint
and the first final batch failed prefer-const before the correction. Earlier passing runs include
74 focused tests, 251 full focused tests and 41 affected tests after security fixes.

PlanR1 Spec accepted; security blocked collector-dependent persistence/unbounded finalization.
Amended planR2 was accepted
by independent security and Spec reviewers before implementation. SourceR1 Standards and Spec
passed; security blocked three P2 findings: early signal-handler removal, missing raw PID during
identity uncertainty, and ancestry handling for `..monitor`. All were corrected with regressions.
SourceR2 on exact `071391eb209e2058c541ce7644bf2da747fff391` passed independent Standards,
Spec and security. No disputed finding remains. Reports accept source, not the author's execution.
Their immutable hashes and both rounds are in JSON.

Independent exact final evidence acceptance and required exact final HEAD green CI remain
premerge gates, recorded on PR #3645 after reviewing this committed evidence. Source checks above
apply to the pinned source; subsequent evidence/handoff-only commits require their own formatting,
diff review and exact CI. Review acceptance is not runtime or owner-delivery acceptance.

The [successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-lifetime-fencing.md)
continues root-to-receiver lifetime fencing, durable lifecycle stop/recovery and independently
verified exact closure before admission can change, then actual image/TigerVNC and ordinary owner
HTTPS/WSS/chat. It preserves all inherited runtime/resource/health/auth/closure gates and the
authorized review→fix→exact checks/evidence/CI→actual merge→verified fresh isolated successor chain.
