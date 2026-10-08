# Scheduled task management — approved design

Ben approved the final #3101 mockup on 2026-10-08 and requested that it be committed and
finalized. This completes the Settings management design task only.

## Primary source

- Design task: https://github.com/motioneso/moss/issues/3101.
- Branch: `prototype/scheduled-task-management`; final UI revision: `bfab305ed`.
- Source: `apps/web/src/settings/scheduled-task-management.prototype.tsx` and sibling CSS/notes.
- Entry: `apps/web/scheduled-task-management.prototype.html`.
- Run from the preview worktree with `pnpm prototype:scheduled-manage --port <claimed port>`.
  Claim a port with `devports claim scheduled-manage-design`; release it after stopping.
- The hosted standalone HTML, identical saved copy, browser evidence and private live state
  remain in the Moss vault under `Design previews/Scheduled proactive design sessions`.

Keep this throwaway branch out of main. The accepted creation and chat-navigation previews
are inherited references, not additional work performed by this design task.

## Accepted decisions

- Group the list into Reminders, Daily, Weekly, More often and Watches. Rows contain a flat
  contextual icon and task title only. Keep completed/expired items under collapsed Past tasks.
- Use Moss’s authored Archivo typography and Park Press system.
- Selecting a task shows its instruction, status, useful schedule information, run history
  and pause/resume/delete. Settings has no Edit control; changes belong in ordinary Moss chat.
- Show specific watch deadlines and non-default result destinations. Omit default Main chat,
  indefinite duration, redundant source labels and obsolete scheduling facts on past tasks.
- Distinguish quiet successful checks from failed runs. Expand dated history for useful recorded
  results and an optional View message action. Management actions are not task runs.
- Retain actionable failure guidance and an inspectable action scope for tasks that change
  user data, including permanent email deletion.
- Confirm deletion with safe Keep task focus. Deleting the schedule stops future work and
  leaves previous messages and completed actions intact.

These decisions supersede #3101’s original dense-list and Settings-editor requirements.
The prototype demonstrates sample cadence edits and pause/resume/delete through chat; it is
not an arbitrary-language editor or a production permissions system.

## Verification and remaining work

The final UI passed web typecheck, scoped ESLint/formatting, design-token and UI-class checks.
The final Firefox flow recorded 16 steps covering list/detail/history, pause/resume/delete,
chat cadence edits, past tasks, failure recovery, preview states, widths 320–1280, phone
keyboard focus/Escape, dark Teal and loaded Archivo. No page errors, network writes, storage
or horizontal overflow were observed. Specific checks retained watch deadlines and destructive
scope while removing routine metadata.

Independent Impeccable critique plus one confirmation scored the pre-trim revision 33/40
(Good), with no major finding remaining in tested paths. The minor phone-chat task-context
recall finding remains. The final detail trim was browser-checked, not independently rescored.

Production persistence, scheduling, permissions, connectors and background execution remain
outside this mockup. Later spec reconciliation and implementation planning must carry these
accepted decisions forward. No later design task or implementation work starts automatically.
