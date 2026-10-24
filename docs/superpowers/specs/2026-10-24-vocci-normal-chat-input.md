# Vocci ring text is automatic Main chat input

Status: approved direction from Ben in the owning conversation on 2026-10-24.
Task: #3584; #3565 and #3584 remain open.

Ben requested removing the separate ring-command section in drawer chat, then
clarified: “I don't want to wait for explicit send, the text should send
automatiocally”. This supersedes this slice's earlier explicit-Send handoff and
boot assumptions and the older ring transcript review/15-minute rules for NEW
admissions. The browser microphone keeps its existing editable draft behavior.

New nonempty versioned voice requests accepted through the opted-in receiver
enter Chat's durable queue automatically, including delayed or uncertain capture
timing. No composer edit or Send click is needed. Existing baseline-inventory and
version-1 exclusions remain: historical Meeting imports do not become commands.
New input uses the existing owner Main destination and ordinary Chat manager,
configured provider, permissions, tool approvals, persisted user message and text
reply. Other/private selections, selection transitions and busy chat defer through
the existing manager fence; ring text never overwrites a typed draft.

Remove the separate Ring voice requests disclosure and scroll area. Pending input
appears as a normal user bubble within the conversation, followed by its recorded
status; completed turns use the canonical saved messages and replies. No new chat,
popup, settings toggle or capture mode. Empty lists render nothing. Loading/error
feedback is inline and uses existing components; failed reads offer Retry.

Persist the admission policy so upgrading does not silently execute old retained
ready-to-send requests. Those remain visible inline with a one-request Send
recovery control. Existing queued work retains its prior age/confirmation policy.
New automatic policy is immutable per receipt; duplicates recover that receipt and
never upgrade an old request. No speech creates no turn. Provider failure before
claim preserves retryable queued work. Uncertain dispatch after effects stays
interrupted, with no automatic retry or one-click resubmission.

All pending requests remain retained. Show multiple arrivals in stable chronological
order; polling, reload/remount and links only read receipts, never send. Recover
completed saved turns missed by the live stream, deduplicating with stable turn and
message identity. Hide ring evidence outside confirmed owner Main, in private/module
chats and during selection/privacy transitions. Owner changes cannot reuse another
owner's cache. URLs resolve owned receipts and select Main without dispatching.

Acceptance: real disposable-owner signup and Settings, configured disclosed ASR/chat
stand-ins, generated audio through the actual receiver/admission/services and real
normal chat UI. Prove automatic message/reply without Send or popup, typed-draft
preservation, multiple requests, busy/private deferral, reload and replay, a real
failure/recovery and legacy pending accessibility. No intercepted Moss responses.
Use isolated verify-gate for DB work and reserved devports. Independent Standards/
Spec review and exact-head required CI precede merge. No phone or production work.

Keep the entire remaining queue in the recovery handoff. Companion 20261027 stays
installed; never reinstall or repeat the completed adapter outage. No deployment,
production recording/replay, hold enrollment, reset/rebind/delete/reboot/firmware or
ownership writes. Virtual Android remains deferred.
