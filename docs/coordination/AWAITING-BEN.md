<!-- Entry rule (2026-09-03): an environment blocker may only be filed here with two proofs named in
the entry: the product's own API/screen showing the thing absent, and the tested checkout at
origin/main (git rev-list --count HEAD..origin/main = 0). See the coordinate skill, Phase 2. -->

# Awaiting Ben

Decisions that need Ben and only Ben. Each entry says what is blocked and what the options are.
Remove an entry once he rules and the ruling is recorded where the work lives. **This file tracks
only currently-open questions — not a historical log.** Resolved entries are removed outright; the
full record survives in git history (`git log -p -- docs/coordination/AWAITING-BEN.md`).

**Protocol (mandatory since 2026-08-05):** no agent idles waiting on Ben without doing BOTH of:

1. Add an entry here — what is blocked, the options, your recommendation.
2. Ping his phone: `needs-ben <your-agent-name> "<one-line question>"` (on PATH box-wide;
   works from any harness — it queues to a Telegram daemon that dedups and rate-limits).

The 2026-08-05 transcript audit found 216 idle hours blocked on Ben, mostly on questions this file
never recorded — an overnight coordinator sat 15h on a question while this file said nothing was
pending. Silent waiting is the failure mode this protocol exists to kill.

<!-- Resolved 2026-08-19: PR #1703 (calendar rebuild) and PR #1717 (all-day scheduling) both merged.
Ben ruled "let's just merge all of these, I'll test in prod" — live-path proof on the dev instance
is no longer the gate for this batch. -->

<!-- Resolved 2026-08-11: #1560 live-path persona cleanup. Ben ruled: "nova is fine for testing,
yep" — approved leaving `ben@ben.com`'s `assistantName='Nova'` as-is, no restore needed. Ruling
recorded on issue #1560 (https://github.com/motioneso/moss/issues/1560#issuecomment-5255044578). -->

<!-- Resolved 2026-08-12: #1533 chat-surface-build Phase 4 live-path proof blocker. PR #1574
("feat(chat): thread surface through send routing (#1533)") merged 2026-08-12T03:11:37Z — the
real-chat-token gap this entry described is moot now that the PR landed. -->

<!-- Resolved 2026-08-19: #1319 signed module catalog. Ben generated the Ed25519 keypair, set the
two GitHub secrets, and shared the public key. Public half committed to PR #1684
(commit 851f9ba70). Real publish/verify proof confirmed (verified: true, key moss-catalog-2026-a).
Ben approved merge; PR #1684 merged. -->

<!-- Resolved 2026-08-05 (PM, via Telegram relay): PR #1379 — Ben ruled delegate the review; QA
lane dispatched. Overnight Codex coordinator pid 1799977 — Ben ruled kill; killed with its MCP
sidecars, verified dead. -->

<!-- Resolved 2026-08-05: Codex grinder lanes (#1246 / #1327) — Ben ruled kill both; sessions
stopped, ruling recorded on issue #1246 and PR #1379. -->

<!-- Resolved 2026-08-11: host disk at 97% (15G free), caused a live ~15-20min ENOSPC blackout of
the coordinator's Bash tool. Root cause found: `docker system df` showed Build Cache at 92.89GB
total / 90.77GB reclaimable — not images, volumes, or the 52 worktrees (only 8.1G combined).
Another agent's earlier `docker system prune` had cleaned images/containers but not build cache.
Ben ruled: run `docker builder prune -f`. Result: 14G → 104G free (97% → 74% used). Resolved, no
further action needed. -->

<!-- Resolved 2026-08-12: Ben ruled "just merge this, tell me how to test there" — merged PR #1574
as 33b722a0f rather than continuing to block on the missing JARVIS_UAT_REAL_CHAT_TOKEN_FILE. Ben
will do the live-path verification himself post-merge; test steps given in the manifest and in
chat. Entry below kept for the historical record, no longer blocking. -->

<!-- Resolved 2026-08-12: #1533 live-path proof, PR #1574 merged as 33b722a0f. Ben ruled "just
merge this, tell me how to test there" and did live-path verification himself post-merge. This
section stayed in the file as a live-looking entry past its resolution; removed by the eighth
coordinator on 2026-08-22 once confirmed done. -->

<!-- Resolved 2026-08-22 13:10: Ben ruled "go with your rec" for both open questions below.

Pull request 1838 — treating the failing check as unrelated flaky-test noise (proof: same test,
same line, also failing on an unrelated main-line change, self-recovering the very next run).
Waiver logged in the run manifest. Proceeding straight to security-tier review without waiting
for a fully green run.

Pull request 1654 — spinning up a dedicated lane to chase issue #1252 (the app's assistant
program not starting during the live test) now that it's blocking a security fix. -->

<!-- Resolved 2026-08-30/31: Ben replied "yes" to the sign-off ask in chat. PR #2117 (module-build
environment isolation, issue #1860) merged 2026-08-31T04:01:24Z. -->

## Open

### Vocci adapter recovery — phone unlock (#3565)

The existing unlock request is routed to `vocci-adapter-recovery`; exclusive
runtime/phone/production ownership transferred to `vocci-copy-rollout`.
The predecessor's explicit-device preflight
found the authorized phone online with Bluetooth ON and the exact live foreground
service, but its lock-screen observation reports locked; native UI comparison and
the single authorized adapter check cannot proceed. No adapter change was issued.
Private `adapter-recovery/preflight.json` records the checks. Tested checkout
was the adapter-recovery slice; later documentation and copy-rollout work does
not provide a fresh unlocked/native preflight. The existing notification remains
routed to its originating agent; do not send another unlock request.

Please unlock the authorized phone when convenient and tell this agent. Recommended:
continue the bounded check after a fresh preflight. Alternatively defer physical
acceptance; offline observer correction/review can proceed independently. No new
recording, enrollment or reinstallation is requested.

### Shared Meeting vocabulary — proposed experience (#3584)

The [feasibility and design proposal](../superpowers/specs/2026-10-24-meeting-vocabulary-proposal.md)
establishes the current ASR seams and provider contracts. This is a product design
decision, not an environment blocker. No setting or implementation has shipped.

Recommendation: an owner-scoped list of spellings in Meetings settings, explicit
Save/Clear, an explicit matching transcript language, and verified selected-target
prompt support. Unknown support keeps the setting unavailable. If a later target
or language becomes incompatible with a saved list, preserve it and reject affected
ASR requests; never silently drop it. Existing failure semantics mean live gaps and
terminal normal-import failures are possible. Clearing/restoring support affects
subsequent requests and does not repair those failures.
Alternative: a best-effort standard prompt with no support guarantee, retaining
transcription when a compatible endpoint silently ignores hints.

Ben must choose the experience and support promise before implementation planning.
The reviewed proposal and primary-source research are the decision material; their
merge does not approve product behavior. Adapter budget proof and live-path
verification remain technical gates after the decision. The existing physical
unlock notification stays separate and must not be duplicated.

No open Outlook calendar decision. Ben approved the
[calendar-first design](../superpowers/specs/2026-10-21-outlook-browser-calendar-sync.md)
on 2026-10-21. Implementation and isolated-dev verification are authorized;
source-quality checks remain required before imports are enabled (#3567).
<!-- Resolved 2026-10-20: Ben approved the Vocci companion spec (task #3553)
in chat: "great, approved". Implementation proceeds under the approved spec. -->

<!-- Resolved 2026-10-21: Ben completed production-wizard Vocci sign-in. Real
inventory/selection/restart passed. The installed UI and state subsequently
confirmed committed ring setup; the combined harness failed on ADB before its
success observation. Browser cleanup signed out the disposable device, isolated
configuration was removed and EMPTY confirmed. This is partial acceptance. -->

<!-- Resolved 2026-10-22: Ben is available for phone/ring steps again.
The latest proof passed physical Verify and Start/hold enrollment, then expired
waiting for fresh samples. Ben is recording during his meeting; no additional
user step is requested during it. Delivery of those samples is unverified. -->
