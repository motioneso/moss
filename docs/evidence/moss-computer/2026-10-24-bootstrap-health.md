# Durable first-health Computer bootstrap evidence

Task #3662; part of #3618/#3617/#3616/#3577, with #3619 open. Internal existing-resource tooling.
[Accepted plan](../../superpowers/plans/2026-10-24-moss-computer-bootstrap-health.md),
[bootstrap dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-bootstrap-health.md),
[exact manifest](2026-10-24-bootstrap-health.json) and
[next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-closure-provenance.md).

## Source and behavior

Base `8786e0a3cd802f9a5e1395628248be5cddc0ad31`; independently accepted exact plan
`e53706ddf253bf3a472690864334634a6ba604ce`. Final checked source
`d146ac16014b3b79ec967bc2483924e3168301f0`; production scripts byte-for-byte equal
`bf545f326811f0297225f3178577d2e5f0d2ae94`. Both independent Security and Standards/Spec source
R2 accept this exact source. Subsequent evidence commits contain documentation only. Checked
source, final PR HEAD and actual merge are separate identities; CI is never attributed to merge SHA.

The original referenced native5s bootstrap timer now includes actual fixed collector startup,
durable collector identity before input release, successful correlated bounded native close,
complete canonical-policy-healthy observation, actual sample file+directory fsync and owned
journal descriptor/path inspection. Terminal/abort/policy/sample age<5s/bootstrap<5s checks run
before persistence and after awaited work, then again after lifetime startup before one-shot
notification. Native acknowledgeStartup independently refuses equality. The latch precedes the
notification; throwing notification is terminal. Final error cleanup cannot count as startup.
No timer renewal, second lifecycle lock or successful health predicate is introduced. Later samples
retain ordinary lifetime bounds. The actual managed caller still supplies its SAME store and
sole lock; unavailableAdmission remains unchanged.

## Exact executed checks and sensitivity

All12 final unpiped checks exit0 at the checked source: **671 tests across30 Computer suites**,
including41 supervisor and58 capture tests; root and tests TypeScript; scoped ESLint zero warnings;
changed-file Prettier; file-size and diff checks; four builtin-only Node24-target CJS bundles
(watchdog/host/provision/closure); gateway context build. The batch used two isolated file workers.
Builds package internal tooling/context only, never Computer images or runtime.

All9 corrected removed-protection controls exit1 at intended assertions, with production restored
byte-for-byte: sample persistence await, owned inspection, bootstrap equality, terminal continuation
checks, post-lifetime recheck, one-shot latch, premature composition acknowledgement, native callback
equality and original native timer. Every accepted patch/log and restoration binding is hash-bound.
The initial sample-await control falsely passed because a simultaneous inspection hold concealed
the missing await. Its raw patch/log/manifest remain retained and excluded. The corrected isolated
sample-only hold exposes the removed protection. No failed round was overwritten.

Both plan R1 reviewers rejected requiring signalled collection to remain alive near5s: killing its
collector and settling cleanup can correctly finish promptly. Accepted R2 splits unsignalled
collection deadline from signalled bounded failure, retaining near5s for held sample persistence.
Source R1 accepted; R2 accepted strengthened independent persistence tests and the complete handoff.
The initial native fixture lacked the watchdog's cross-process output-descriptor projection;
a corrected positive run passed. A later telemetry addition initially caused the harness to mistake
timer creation for held I/O, producing retained timing/signal failures. Corrected native-r4 passed
all8 cases; the final batch also delays repeated signals1800ms after held persistence to distinguish
the original bootstrap deadline from a newly started terminal-finalization deadline. Raw failed
and diagnostic runs remain retained with exact hashes; they do not qualify the final result.

## Native composition and limits

Eight artifact/source-bound native receipts execute the actual production CJS, separately executed
fixed collector and observeComputer, canonical policy, actual journal and native timer callback.
Disclosed OS root/group/runtime/namespace/cgroup/heartbeat/Node/resource projections and a collector
OS-preload executable wrapper enable the fixtures. The wrapper preserves detached child execution,
empty environment and production stdio settings; it never replaces collector output with a healthy
object. Readiness and Docker use real private Unix HTTP stand-ins. First-I/O timestamps and actual
native process identities remain exercised. These projections do not qualify installed trust.

Held capture file/directory elapsed5008.603/5013.826ms; held first-sample file/directory
elapsed5009.970/5034.706ms, despite repeated TERM/INT. Unsignalled held collection exits at5017.805ms;
signalled collection fails promptly at483.377ms. All satisfy observed original-timer bounds
4900<=elapsed<6800ms where a lower bound applies. Positive acknowledgement at1508.185ms follows
actual sample file+directory fsync; exact native callback equality at1011.126ms refuses acknowledgement.
Every receipt records exit2, no native signal and empty stdout/stderr, with retained lock/capture
output and GET-only Docker calls. The positive fixture deliberately fails without an installed
receiver; acknowledgement means first durable healthy sample, never activation, closure or admission.
Bare unprojected production CJS also refuses actual nonroot execution silently with exit2.
Execution uses native Node22; Node24 bundle metadata does not qualify Node24/image/128MiB fit.

The sample concerns already recorded resources and does NOT satisfy the distinct independently
alive watchdog AND first complete healthy sample BEFORE-launch ordering. Repeated capture is
neither continuous nor final pre-stop descendant closure; existing closure remains init-tuple based.
Installed signing/closure provenance, final descendant reconciliation, new-run/reset/uncertain-create,
actual Node24/128MiB/TigerVNC/fixed lifecycle, API leases/dispatch, real owner HTTPS/WSS/chat and
independent hostile/live acceptance remain separately gated. All owner parents stay OPEN.
No actual Computer image/runtime, Docker mutation, DB, browser, TCP server, installation or deployment
occurred. Final independent local acceptance, exact final-HEAD required green CI, supplemental
acceptance, protected actual merge and verified fresh isolated successor remain release gates.
