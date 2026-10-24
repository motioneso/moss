# Moss Computer viewer diagnosis: unresolved, no runtime replay

**UNRESOLVED_NO_SUPPORTED_REPAIR.** The retained evidence does not identify the cause of r12's
viewer timeout. No connection repair is claimed. The handoff's unsupported-repair kill gate was
applied: **zero new desktop attempts**, no image load and persistence **NOT_RUN**.

Authority: [viewer-repair handoff](../../superpowers/handoffs/2026-10-23-moss-computer-viewer-repair.md).
The [diagnostic plan](../../superpowers/plans/2026-10-23-moss-computer-viewer-diagnosis.md) was committed
at `776c59316`. Operator: Codex `/root`; independent read-only reviewer: `/root/viewer_review`.
Private receipts and the offline check are retained in `../moss-computer-viewer-repair-private/`.
The [sanitized JSON](2026-10-23-viewer-diagnosis.json) records exact comparisons and receipt hashes.

## Evidence and ranked hypotheses

The actual r11 `startup.mjs` and r12 `persistence.mjs` connection functions are byte-identical,
SHA-256 `c816d3beeac81d0987259917d3283d2f4d7447e7e9a9e972cbd35df4aecee04e`.
Compose, gateway configuration, readiness and access scripts, guest RFB probe and WebSocket RFB
parser match after explicit port/run-name normalization. Added Firefox/replacement operations
occur after connection and were never reached. The full probe files still match their retained
launch manifests. All 52 r11 and 39 r12 final raw-receipt hashes, and all 34/27 recorded surviving
launch-artifact hashes, match the tracked final evidence.

R12's retained bounded backend tail ends with a connection opened at 22:00:34.914 UTC and cleanly
closed at 22:00:34.924, during restored access. Its browser operation started at 22:00:35.485.
No later browser connection appears in that tail before failure. This narrows investigation to
the browser/upgrade boundary; it does not establish that the browser made no WebSocket attempt.
Gateway warning logs were empty and access logging was off. Current UI/RFB state, settings, DOM
status, console, unhandled promise rejection and browser WebSocket/request-failure data were not
retained. The old `pageerror` and HTTP-error listeners do not provide those missing observations.

| Rank | Hypothesis                                                       | Discriminating observation                                              | Result                        |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| 1    | UI initialization rejects before autoconnect                     | Actual startup promise rejection and final DOM/status/settings state    | Missing from r12; unsupported |
| 2    | Browser WebSocket/TLS fails before upstream forwarding           | Actual WebSocket request/error/close and browser transport failure      | Missing from r12; unsupported |
| 3    | Settings or imported UI state differs from the rendered instance | Actual UI/RFB identity and effective host/port/path versus document URL | Missing from r12; unsupported |

The exact retained noVNC source calls the asynchronous, handled `package.json` fetch early in
`UI.start`, before its remaining initialization and autoconnect. Both passing r11 and failed r12
recorded the 404. It proves neither completed UI initialization nor a causal failure.

## Offline discriminator and its limits

The retained candidate UI and installed host UI are byte-identical, SHA-256
`70ba76ca86ceaea27dc338bbfee4cebcfef1160812c8d410241f3667dff4864c`.
The reviewer ran the verbatim extracted `prime` method in a Node VM with explicit DOM/settings
doubles and a stub `start`. All four tested orderings started once: settings before DOM,
settings after DOM, import after DOM, and import after load. Removing the actual ready-state
fast path was verified to change the method and made the late-settings control start zero times;
the oracle rejected it. A retained operator replay also exited 0 on Node v22.22.2.

This check discriminates against the proposed missed-DOM-event race in that method. It does not
exercise downstream `UI.start`, a browser, TLS, RFB or a desktop. There is no deterministic
reproducer of the user's connection failure and therefore no evidence-backed causal patch.
No synthetic result is substituted for real UI/frame/input acceptance.

One read-only comparison initially exited 1 because it compared runtime-mutated
`receipts/access.json` with its prelaunch value. That receipt matches the tracked final r12
hash. Separating final receipts from immutable source checks corrected the checker; no old
artifact was edited and no runtime assertion or admission was retried.

## Admission, closure and qualification ledger

Fresh entry at 2026-10-24 01:21:46.408 UTC passed: RAM 39,025,819,648/root 37,538,738,176/data
976,592,678,912 bytes; Moss running healthy and health `ok:true`. Docker inspection returned
the exact adopted image absent. Since no causal repair was supported, archive verification,
restoration review/load, fresh launch identities and an exact runtime packet were not prepared.
Image absence is not an explanation for historical r12, which ran with that image present.

No browser, watchdog, guest, gateway, network, port reservation/listener or ephemeral keys were
created. Operator closure found empty exact proposed-r13/r12/r11 container and network labels,
no new runtime directories/reservation, retained earlier homes/archive and healthy Moss.
Prior homes/archive were checked for existence, not comprehensively rehashed. Historical r11/r12
watchdog stop files both say `operator closure` plus `NO_RUNNING_PROOF_CONTAINERS`; all 2/14
samples were included in the verified raw receipts. No fresh watchdog result is claimed.

| Predicate for this dispatch                                                    | Status                    |
| ------------------------------------------------------------------------------ | ------------------------- |
| Retained evidence/source comparison; bounded offline scheduling discriminator  | PASS within stated limits |
| Causal diagnosis and viewer repair                                             | UNRESOLVED                |
| Launch readiness / new desktop runtime                                         | NOT_READY / NOT_RUN       |
| Real current UI/RFB, visible frame and fresh input                             | NOT_RUN                   |
| Active Firefox sandbox, clean shutdown/flush, persistence negative controls    | NOT_RUN                   |
| Desktop replacement, unchanged durable hashes, fresh browser UI/input readback | NOT_RUN                   |

The reviewer independently agreed that retained evidence cannot support a repair or blind replay.
Exact final evidence/closure review is recorded in the [review ledger](2026-10-23-independent-review.md).
The unused conditional attempt grants no readiness or acceptance. There was no failure resampling,
deadline increase, security change, image substitution, production deployment, merge or issue closure.
R11 remains historical bounded startup/input acceptance; persistence and actual owner integration
remain open. Live #3607 is an unmerged draft on unmerged #3598; this draft stacks on #3607.

One next proposal: prepare a separately reviewed browser-boundary diagnostic candidate retaining
bounded startup rejection, console/request/WebSocket errors and final UI/RFB/DOM/settings state,
then establish a discriminating causal check before proposing another desktop proof. No runtime
launch is authorized by this report, and no additional product foundation is represented as delivered.
