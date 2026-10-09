# Existing quiet-hours delivery prerequisite (#3158)

Parent #3130, within #3096. This native session-sizing split is grounded by pre-code source
inspection at integration `04bcabc42`. All approved mockups, migration rulings and existing
UI/API/worker verification seams remain approved. The audit made no code change and establishes
no executed defect or green test result.

## Scope and native graph

#3158 repairs the existing saved Profile quiet window's local notification defer/release behavior
and compatible proactive quiet-end calculation. It includes the existing Profile UI, real
notification-producing worker, relevant checks, independent reviews, app-map metadata and recorded
evidence in one fresh session. It blocks original #3130; #3131 still waits for #3130. The verified
graph has 32 nodes and 39 blocking edges and is acyclic.

Original #3130 remains a complete builder for canonical raw saved-record carry-forward, all three
writers and revision/CAS/undo safety, the accepted editor, saved/draft/retry feedback,
unresolved-conflict preservation and its own installed proof. Revalidate that ticket's fit after
#3158 integrates; the prerequisite does not certify the remaining scope fits.

## Ownership and boundary policy

Own the existing notification and proactive daily quiet-end consumers, the smallest compatible
shared time primitive if necessary, their actual callers/fixtures, relevant owning metadata and
installed test harness. Preserve separate Profile/proactive settings and current writers. The
Settings shell ownership transferred by #3129 remains reserved for #3130. No canonical migration,
new editor, conflict choice, task allowance, urgency change or cap-day accounting belongs here.

Preserve current local wall membership: start inclusive, end exclusive, overnight wrapping and
legacy equal-time all-day handling. Use the correct local calendar date for a window's end,
including UTC+14. A nonexistent spring end resolves to the first valid instant after the gap; a
repeated fall end resolves to the later occurrence. Previously deferred work waits until that
cutoff; newly created work outside wall membership remains outside, including first-fold 01:45 for
an end of 01:30. Preserve the strict local instant API's rejection of ambiguous/nonexistent inputs.
Profile's unset zone resolves through the owner's locale then UTC; proactive keeps its existing
owner-locale resolution and distinct saved schedule.

## Verification and actual demonstration

Reproduce a failing behavioral check before changing arithmetic. Verify ordinary overnight, UTC+14,
spring gap, both fold quiet portions, outside membership and exact end through independent literal
expectations. Check relevant focus/mute/urgent/default behavior and actual notification
creation/visibility. Run DB checks only through `verify-gate` and the existing run-gate script,
required static checks and affected non-DB suites; record exact pins, fingerprints and terminal
exits.

Through existing installed Profile controls, save/reload an overnight schedule and the owner's
locale. Save a current window ending a few minutes ahead, invoke an existing authenticated briefing
run with a configured provider, await its real worker's public completion, then prove its normal
notification absent before the local cutoff and visible once afterward. Verify the existing summary
job's release where applicable without claiming device receipt when no device is registered. Prove
proactive boundary parity while separate saved policies remain separate. Deterministic DST checks
supplement this UI/API/worker demonstration.

Use the existing isolated UAT provisioner, capture off, a claimed development port, uniquely pinned
runtime image and disposable resources. No screenshots or rewritten Moss responses. Commit
public-safe per-ticket evidence, complete sequential independent Standards/Spec review and clean up
owned resources before handing a clean pushed branch to the merger. No auto-merge or deployment.
