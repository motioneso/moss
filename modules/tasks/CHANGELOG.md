# Tasks package changes

## Unreleased

- Interpret task searches from the package screen, remove individual conditions, and keep ordinary text search usable when AI is unavailable.
- Compare interpreted filtering with the unchanged legacy screen; retain UTC date behaviour until account timezone support arrives.

- Include, show only or hide lists, combine tag filters, and clear filters in the package screen.
- Show per-list counts after status and tags, before search; compare the filter model with the legacy screen over 800 combinations.

- Group List view by priority, highest first, with unprioritised tasks last.
- Order List and Grid groups by due date then title, using the legacy grid labels.
- Use Critical and Someday in the task editor and compare view grouping with the legacy screen.

- Add focus, at-risk and overdue routes and tools, plus a bounded twelve-row summary tool.
- Compare compiled drift and summary results with the TypeScript executors and check privacy with row-level security removed and restored.
- Days use UTC and recurring series are not advanced until the public actor-timezone seam exists.

- Delete lists through confirmed package-screen actions, HTTP and the assistant handler, optionally keeping tasks in another owned list.
- Preserve the final list across concurrent package deletion requests; check compiled privacy and lock-removal controls.

- Manage each list's tags in the package screen: create, rename and confirmed deletion, with draft protection.
- Check the compiled tag routes with privacy removal controls and verify browser tag persistence.

- Add the filtered task-list tool with legacy result ordering, tags and column order.
- Compare compiled list results and privacy against the TypeScript executor; local-day recurrence and installed chat dispatch remain unfinished.

- Add bounded owner-only heartbeat reads with revisions and time boundaries.
- Add deferred-status enqueue and worker handlers using the captured account.
- Check real queue enqueue/claim, a directly invoked compiled handler, and exact heartbeat results on a disposable database.
- Full queue policy parity, background authorization and remote-device proof remain unfinished.

- Add twelve compiled task, list, tag, activity and breakdown action handlers.
- Add ordered task breakdown with parent activity and invocation rollback.
- Compare mutation results with current TypeScript executors in the disposable gate.

- Repair initial screen loading when the frame loads before its bridge connects.
- Save task, list, tag, subtask and comment forms through the sandbox bridge.
- Apply the shared document typography inside the isolated package screen.
- Run Tasks Rust code as a Wasm component using the approved generated ABI binding.
- Add basic task, list, tag, activity and view preference routes over the shared host.
- Add task completion cascades, list moves and next-occurrence generation.
- Build reproducible unsigned archives with the unchanged Tasks migrations.
- Add package screens for tasks, lists, subtasks, tags and activity using the shared kit.
- Preserve saved dates and repeat rules on unrelated editor changes.
- Encode whole-number recurrence intervals consistently with the existing API.
- Add a disposable signed-install HTTPS UI check.
- Full screen/endpoint/tool/job parity, real-shell integration and remote-device proof remain unfinished.
