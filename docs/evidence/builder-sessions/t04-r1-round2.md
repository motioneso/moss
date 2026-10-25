# T04-R1 round 2 - re-review of T04-C1 r2

Date: 2026-10-25. Read-only. Independent of the author and of the first reviewer. No product file changed, nothing run, no network.

## Inputs
- Prompt T04-R1.txt sha256 20933f42...86101186c: matches.
- Reviewed: t04-c1.md r2, sha256 250792d52bda2e998012c343d1761493fe6b6f3f736df3b4b366cbb85b6078f6: matches.
- Compared with: t04-r1.md (first review).
- Source: /tmp/coord/main-ro at ff07aff5bbe095c6d38a55fa0913c23b3d3439da (confirmed HEAD).

## Verdict: accept with changes

Findings 1, 2 and 4 are resolved. Finding 3 is resolved except for gaps the report itself discloses. The report still carries stale r1 text that contradicts r2.

## First-review findings

| # | Status | Basis |
|---|---|---|
| 1 stale pin, false "identical" | Resolved | Withdrawn; anchored to ff07aff5b; four-file drift table. Guard lines match source (launch flag 178 and 420; replay checks at gateway 392, native 42, ACP 245). |
| 2 new routes unmapped | Resolved | Six routes mapped; each exists in source. |
| 3 S8/S9/S10/S12 one by one | Resolved with disclosed gaps | Table present. S8 scheduled-retry and S10 missing/corrected evidence are marked unproved, not claimed. |
| 4 old data or permissions restored | Resolved | Restore table plus a required negative case. Consistent with source (provenance taint kept with coalesce; tokens held in an in-memory map). |
| 5 GitHub rulings unreconfirmed | Open, honestly stated | Coordinator must reread. |
| 6 process notes | Open | ZIP extraction and Tailscale read still rest on an unconfirmed user instruction. |

## Source spot-checks (12, all hold unless noted)

1. Launch taint flag set in the ACP engine only (acp-chat-engine 420; launch 178).
2. Replay refusal at the three sites above.
3. Runner returns SCHEDULED_SOURCE_CHANGED as a failed outcome (runner 144); read failure gives "Read failed" (100).
4. Runner has no module or AI-consent check (no match in file). The S8 gap is real.
5. Background read refuses anything but tasks.get (gateway 571).
6. Act-as grant lifetime 30_000 ms (act-as-grants 15).
7. Voice routes refuse an act-as header (routes 26, 65); stale dispatch under a different boot id is handled (service 86); voice files contain no content-admission call.
8. Outlook mirror: readOnly and unconfirmed flags (calendar.ts 235-236); per-account calendar grant gap "feature_grant_disabled" (285-286).
9. API-key launch returns null for non-active, revoked, or unreadable rows (api-key-launch 66-75); key goes in env MOSS_OPENCODE_API_KEY (cli-runner acp-launch-credential 56).
10. Visual present tool is content "outside" (present-tool 29).
11. Constrained structured calls return error "per_user_isolation_required" when isolation is unavailable (engine-host 696-701).
12. No packages/extensions exists.

Discrepancy: r2 says retry-once-only "is r1's statement, not shown". Source allows up to two retries (runner: min(retryLimit, 2)). Correct the wording.

## Changes required
1. Remove or mark superseded the stale r1 text. The line-24 status (open or closed) and the "Version and authority ledger" HEAD are r1-era. The "All implementation links are pinned to refreshed main" sentence is wrong, since those links use 70562d7. The "Initial report verification" paragraph and "final pin/status" refer to the old pin. The report's size statement is also stale.
2. Fix the retry wording above.
3. Reconfirm the GitHub rulings (finding 5) and confirm the extraction instruction (finding 6).
4. Name the S10 missing and corrected-evidence cases as an explicit open test.

## Not verified
Nothing executed. Native isolation boundary, real account reads (Outlook included), complete provider connection including the API-key path, whether the agent can read its own environment key, and whether voice transcripts of other people's speech are marked as outside content all remain unproven. This is source reading only, not a safety claim.

## Decisions for Ben
The four in the report: (1) non-YOLO trusted add-on writes to declared hosts, (2) absolute "no source-influenced action" only if the controlled case needs it, (3) API-key in the agent environment, (4) marking of others' speech in voice transcripts.
