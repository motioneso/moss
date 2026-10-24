# Moss Computer: bounded viewer diagnosis

Task #3578 / parent #3577; integration foundation #3605. Authority: the
[viewer-repair handoff](../handoffs/2026-10-23-moss-computer-viewer-repair.md).
Operator: Codex `/root`; independent read-only reviewer: `/root/viewer_review`.
Private live state and diagnostic receipts: `../moss-computer-viewer-repair-private/`.
Historical roots remain read-only.

## Decisions and sequence

1. Compare actual accepted r11 and rejected r12 connection, readiness, access and transport paths,
   including the retained image's noVNC implementation. Check retained receipt/source hashes.
2. Rank initialization rejection, browser WebSocket/TLS rejection, and configuration/module-state
   mismatch against the actual observations. Separate the handled package-version 404 from causal
   evidence. Check the proposed DOM/settings race using the exact vendor `prime` method in a
   bounded offline VM; a removed readiness fast path must make its oracle reject the defect.
3. Implement a connection repair only if a discriminating offline check supports it. Preserve
   all real current-UI/RFB, visible-frame, fresh-input, security, deadline and persistence assertions.
   A VM success establishes only method scheduling, never a connected desktop.
4. Before any permitted desktop attempt, commit the supported repair and exact fresh launch packet,
   obtain independent actual-artifact acceptance, and repeat admission immediately before launch.
   Inherit the complete r12 acceptance sequence and the repair handoff's limits without relaxation.
5. If evidence cannot support a repair, end diagnosis with `UNRESOLVED_NO_SUPPORTED_REPAIR` and
   persistence `NOT_RUN`. Preserve the unused attempt; do not load the image or prepare launch
   identities merely to repeat the known timeout. Independently review the exact final evidence
   and no-runtime closure, commit/push scoped documents, and open a draft stacked on the actual
   unmerged dependency. No merge, deployment or issue closure.

The kill gate belongs to Codex `/root`: no evidence-backed causal repair means no runtime launch.
There are no model calls, product UI changes, new app-map capabilities or database commands in
this diagnostic slice. Any later implementation needs its own committed bounded plan.

## Verification and limits

The offline check must exercise the extracted actual method across DOM/settings orderings and
observe the broken-method control failing. Source/receipt checks must reject changed bytes.
Expected exit 0 for the diagnostic checks, scoped formatting, relative links and `git diff --check`.
Actual desktop, sandbox, clean flush and replacement remain separate live predicates.

The [result](../../evidence/moss-computer/2026-10-23-viewer-diagnosis.md) records the stopping decision
and exact receipts. This document is a diagnostic plan, not an accepted runtime launch packet.

## Resumed diagnosis: direct user instruction supersedes the stopping decision

Ben subsequently instructed: “The kill gate wasn't my decision. This needs to be repaired so
keep going.” The previous unsupported-repair stop is historical and superseded. Continue the
diagnostic feedback loop through an instrumented browser and, when needed, the isolated desktop.
The image, isolation, host-resource, credential, independent-review and cleanup protections remain.

1. Exercise the complete installed noVNC UI in the same Chromium/browser viewport as r12. Use a
   claimed loopback port and fresh private TLS/client identities. Capture bounded console, page
   errors, startup rejections, request/WebSocket failures and actual UI/DOM/settings state before
   teardown. A static-server diagnostic may establish initialization behavior only; it cannot
   qualify a connected desktop. Preserve historical artifacts. Keep scripts/logs outside git.
2. If initialization succeeds, prepare an exact instrumented r13 desktop packet using the retained
   r12 scripts, fresh home/socket/keys and claimed port. Check archive/config/seven payload layers
   if the adopted image is absent, obtain independent restoration acceptance, then load that exact
   image once. Commit packet and actual-artifact manifest; obtain independent readiness review.
3. Run fresh admission and the existing independent watchdog before launch. Keep existing current
   UI/RFB, frame, fresh-input, sandbox and persistence assertions and deadlines. Diagnose captured
   failures and make targeted corrections supported by the observed boundary; user authorization
   permits continuing diagnosis rather than ending solely because a repair is not yet known.
   Stop each failed operation, preserve its evidence and close resources before a separately
   identified corrected attempt; never resample failed admission or weaken protections.
4. Verify the real repaired viewer and finish active sandbox, clean shutdown/profile flush,
   file/bookmark negative controls, replacement on the same home, unchanged durable hashes and
   fresh UI/input readback. Report only observed results, independently review final evidence and
   closure, commit/push the draft stack and leave a clean tree. No deployment, merge or issue close.

Existing seams: r12 `persistence.mjs` lines 42–53 contain the real UI/RFB/frame predicates;
lines 128–163 contain the persistence sequence and browser setup. `run.py` lines 58–82 binds
manifest/admission/watchdog/readiness/access/persistence; `supervise.py` lines 17–46 samples
resource floors and stops exact owned resources. Reconfirm line ranges when preparing the packet.
No model calls or product UI feedback are introduced; all evidence is generated from observed state.
Expected diagnostic exit 0 means its explicitly named browser boundary was observed, never desktop
acceptance. Real proof requires the original full predicate sequence and independent closure.

### Observed first-sample race: bounded runner correction

The r15 runner passed prelaunch admission but failed before `launch`: the watchdog created its
log before writing the first sample, and `read_text().splitlines()[0]` raised `IndexError`.
Correct this actual runner seam before the next exact packet. A small `await_first_sample(root,
watch, timeout=10)` helper must wait for a complete first JSONL record while rejecting an exited
watchdog, stop intent, malformed complete record, unhealthy sample or the original 10-second
deadline. The regression must observe the original code rejecting an empty newly-created log,
then verify delayed/partial sample completion succeeds and dead/stopped/malformed/unhealthy or
timed-out monitors fail closed. No desktop or viewer assertions change. Independently review a
fresh r16 identity and actual helper/call-site inputs before the next launch.
