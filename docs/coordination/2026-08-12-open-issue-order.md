# Open issue execution order — 2026-08-12

GitHub Project 2 remains the source of truth. This is a compact audit snapshot explaining the
board order, not a second status tracker.

## Audit result

- Audited all 147 issues that were open at the start of the pass against current `origin/main`,
  linked PRs, issue comments, labels, and board state.
- Closed seven issues whose acceptance is already present on `main`: #928, #942, #1087, #1135,
  #1481, #1569, and #1581.
- Corrected the remaining scope of #899, #1084, #1105, #1248, and #1556.
- Added missing type, security, and `needs-spec` labels to 26 unlabeled issues.
- PR #1594 merged during this pass and closed #1429 after its live-path repair landed.
- Ordered the 139 remaining issues below and applied the same P0/P1/P2 order to Project 2.

Audit meanings:

- **P0** — production incident, security boundary, or release-integrity work. Interrupts P1/P2.
- **P1** — confirmed defect, test/reliability hardening, or approved work with a concrete exit.
- **P2** — product expansion, design/spec work, epics, and deliberately deferred work.
- A parent immediately followed by indented slices means execute the slices in that order; do not
  build the umbrella separately.

## P0 — production, security, and release integrity

1. #1590 — move `notes.sync` embedding off the worker event loop; first produce the required short
   runtime/queue-isolation spec.
2. #1589 — verify production job recovery and close the incident after #1590 or an interim
   mitigation is live.
3. #895 — make the full foundation/app and compose checks required on `main`; current repository
   rulesets do not enforce them.
4. #1489 — owner-scope the task-breakdown parent lookup.
5. #1591 — remove the confirmation existence/liveness oracle by checking ownership first.
6. #1141 — isolate provider auth probes from ambient host credentials.
7. #943 — reset the module runtime role after storage RPC calls.
8. #1252 — make external-module tool failure truthfully reach the action audit log; approve the
   existing protocol spec before build.
9. #1275 — bound external-module `inputSchema.pattern` execution on the host event loop.
10. #1274 — reject unsafe/unbounded schema patterns at install time.
11. #1488 — finish the role-marker/untrusted-recall fencing design, then execute #1508.

## P1 — confirmed defects and hardening

1. #1556 — notes-default retrieval phase from the approved #1553 spec; bounded replay is already
   merged.
2. #1592 — keep reject/cancel working when the AI gateway is unwired.
3. #1585 — recover stale News snapshots after the worker-runtime incident is fixed.
4. #1454 — alert when a skipped image publish prevents production from updating.
5. #1108 — auto-select and validate non-overlapping UAT Docker subnets.
6. #1013 — serialize cluster-global migration DDL across parallel verification lanes.
7. #1325 — make API-key provider creation truthful and usable from Settings.
8. #1495 — require a surface key before seed/submit can fall through to the drawer.
9. #1487 — make SPA fallback handling correct without relying on `Accept: text/html`.
10. #1467 — pass non-empty notes roots to permission hooks in containers.
11. #1223 — prevent foreign-owned `.prev-*` backups from wedging module update/remove.
12. #1222 — exclude `.prev-*` backup directories from module discovery.
13. #1057 — honor exact module pins even when another version is already on disk.
14. #1042 — replace the module-install compose instruction that can silently no-op.
15. #1029 — repair or retire the obsolete Gemini interactive transcript reader as part of the
    persistent Gemini direction.
16. #927 — re-triage the old parent-task save failure with a current reproduction before code.
17. #1191 — diagnose and repair Assistant persona preview.
18. #1219 — make module onboarding useful when no chat model is configured.
19. #1258 — add the safe persistent-dev doctor/provisioning path.
20. #1468 — extend target-identity guards to the remaining destructive scripts.
21. #1279 — pin module tools to the shared gateway validator and name rejected tools.
22. #946 — complete native host-fetch SSRF parity and control tests.
23. #1490 — add the manage-share cross-owner regression test.
24. #1037 — prove foreign-thread resume is RLS-denied.
25. #1038 — prove two-user isolation across chat privacy/history endpoints.
26. #1039 — distinguish force-replay from private-history purge in tests.
27. #1246 — re-slice the approved install-time permission-grant plan; the prior long-running build
    was stopped and nothing is currently in progress.
28. #1249 — add the explicit outbound action class after #1246's base contract.
29. #1266 — add the user-facing always-confirm override after the install-grant model.
30. #1339 — security/self-heal umbrella; execute only its remaining slices:
    1. #1529 — prove composed dispatch and task self-heal.
    2. #1530 — degrade a failed task heal closed.
31. #1137 — robustness umbrella; execute only its slices:
    1. #1511 — validate share targets before writes.
    2. #1512 — recheck note paths immediately before filesystem I/O.
    3. #1513 — serialize concurrent note edits per path.
    4. #1514 — make commitment-candidate upsert atomic.
    5. #1515 — warn safely on extraction failure.
    6. #1516 — validate commitment tool/status boundaries.
    7. #1517 — escape evidence excerpts as plain text.
32. #1138 — weather and upgrade-check outbound HTTP hardening.
33. #1140 — backend-low umbrella; execute only its slices:
    1. #1523 — expire News previews.
    2. #1524 — make whole-league sports follows unique.
    3. #1525 — bound cancel-only submit tombstones.
    4. #1526 — propagate terminal backpressure to the PTY.
    5. #1527 — make crash shutdown single-flight.
    6. #1528 — return fixed account-state error text.
34. #1139 — web chat/export umbrella; execute only its slices:
    1. #1518 — make action resolution single-flight and unmount-safe.
    2. #1519 — preserve identical fallbacks until their own SSE records arrive.
    3. #1520 — stabilize queued-chat draining during SSE updates.
    4. #1521 — keep private chat closed during focus refetch.
    5. #1522 — resume export progress after Settings remount.
35. #1335 — typecheck repo-root `.tsx` tests.
36. #1336 — validate the job-search match-list wire shape at runtime.
37. #1418 — remove the Finance `ReactNodeLike = unknown` type shim.
38. #1416 — collapse the duplicate Settings/UI Select implementation.
39. #1120 — make the module-SDK barrel browser-safe.
40. #1106 — live UAT for undeclared-module trust warning and credentials.
41. #1107 — deterministic herdr-install failure injection for UAT.
42. #1105 — deterministic credential-free chat/thread seed and timing controls.
43. #899 — mocked `/news` overview e2e only; screenshots are explicitly out of scope.
44. #948 — disabled/hash-drift/impersonation coverage for `openAssistant`.
45. #951 — auditable cross-owner purge of module KV on uninstall.
46. #1508 — implement the approved Unicode-safe vocabulary and composed-renderer contracts after
    #1488.
47. #1319 — sign and verify the module distribution index after its security spec is approved.

## P2 — planned product and architecture work

Work top-to-bottom; child sequences stay contiguous.

1. #1470 — non-feature backlog freshness/burn-down epic (tracking only).
2. #1588 — growing in-app changelog; design spec first.
3. #1586 — Moss-visible News pipeline diagnostics and safe refresh controls.
4. #1571 — replace coordinate entry with a city-based weather override.
5. #1572 — user-configurable sports sources by sport/league.
6. #1558 — persistent Codex adapter behind the neutral runtime contract.
7. #1559 — persistent Gemini adapter; absorb #1029 where the old reader is retired.
8. #1440 — Moss rename epic; remaining sequence:
   1. #1463 — external-module display strings and artifact versions.
   2. #1461 — Postgres runtime roles.
   3. #1444 — final database/image/repository cutover.
9. #901 — self-hosted TLS story; execute its slices:
   1. #1504 — opt-in Caddy production profile.
   2. #1505 — TLS origins and scoped proxy trust.
   3. #1506 — CA/ACME/rollback/upgrade runbooks.
   4. #1507 — second-device distributable HTTPS proof.
10. #1427 — CSS guard-4 completion; execute its slices:
    1. #1497 — extract Today residue into `@moss/ui` and register its layout sheets.
    2. #1498 — extract command-palette visual residue into `@moss/ui`.
    3. #1499 — finish assistant-surface CSS registration.
    4. #1500 — move shared web form visuals under `@moss/ui`.
    5. #1501 — move keyline and global texture visuals under `@moss/ui`.
    6. #1502 — split and register global web visuals.
    7. #1503 — graduate guard 4 and prove the complete web CSS migration.
11. #1425 — sun/moon theme toggle and command action.
12. #1426 — allow custom themes to enter dark mode.
13. #1428 — split the Google-sync/structured-AI overhaul into an approved spec.
14. #1424 — lane-efficiency improvements for safe async/read-only work.
15. #1423 — reap orphaned dev processes and stale one-shot directories.
16. #1422 — stable one-shot working directories for prompt-cache hits.
17. #1421 — route job-fit scoring to the economy model tier.
18. #1378 — per-account webmail source-link base URL.
19. #1368 — save chat transcripts into user notes at session end.
20. #1349 — broaden medication frequency without overcomplicating the form.
21. #1343 — consistent module-header template.
22. #1337 — nullable-object support in tool-output sanitization.
23. #1312 — retire “external module” vocabulary.
24. #1248 — decide which first-party internal-vault writes become searchable, then wire ingestion.
25. #1218 — private/shared Lists module.
26. #1192 — explain connected-account sync caps and recovery.
27. #1184 — prioritize default/followed/starred leagues in standings.
28. #1181 — configurable People mapped-folder source.
29. #1116 — flatten the Tasks priority-group visual treatment.
30. #1113 — ship a distinct display typeface.
31. #1100 — surface CLI catalog-versus-installed version drift.
32. #1084 — remaining required-transition, switch-truth, and Settings-primitives follow-ups.
33. #1070 — backup status and point-in-time restore.
34. #1069 — safe instance-wide data export.
35. #1061 — GitHub connected-account integration.
36. #1033 — capability audit for changing sources/settings through Moss.
37. #1003 — iCloud Mail and Calendar provider.
38. #950 — credentials for custom News publishers.
39. #926 — food and macro tracking.
40. #906 — “more/less like this” feedback for News and Sports.
41. #871 — natural-language Assistant/AI administration.
42. #869 — Assistant/AI admin simplification epic.
43. #860 — pluggable-module distribution epic.
44. #827 — deferred feature-gap backlog; activate only when its documented triggers fire.
45. #819 — workflow-layer epic.
46. #818 — open user-authored module-system epic.
47. #743 — Web Push delivery, deferred to the post-first-week roadmap.

## Re-audit triggers

- Close an umbrella when all listed slices close; do not leave it as a second implementation task.
- Move an item to **Ready** only when required design/spec decisions are approved.
- Move an item to **In progress** only when a live branch/agent owns it, and to **In review** when a
  PR is open.
- Re-run this audit after either 25 issue closures or 30 days, whichever comes first.
