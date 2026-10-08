# Scheduled task management — throwaway design preview

Design mockup for task #3101, using fictional data and browser-memory state. Source brief:
the Moss vault's `Design previews/Scheduled proactive design sessions/02-manage-tasks.md`.
This branch inherits #3100's accepted ordinary-chat creation preview. Keep it out of main.

The Settings list shows reminders, recurring checks and watches, including active, paused,
completed, expired and failed records. Each record exposes instruction, timing/trigger,
destination and recent outcome. Completed and expired records retain their details and history.
A successful quiet check says it succeeded without sending a message; a failure explains the
problem and what to do next.

Inspect a record, edit it, pause/resume or delete it. Timing, destination and instruction edits
save directly within the existing allowed actions. Changing allowed actions displays the old
and proposed sets and requires approval before saving; cancellation keeps the old record.
Saving edits does not rerun the task or reactivate a finished record. Deletion confirms that
future work stops while previous messages and completed actions remain.

The sample chat accepts `pause AI news`, `resume AI news`, and `delete AI news`, then a typed
confirmation for deletion. Ordinary replies update the same record shown in Settings. It uses
a 380px desktop dock and a full-width phone drawer. The conversation menu demonstrates the
accepted closed overlay and direct-to-composer side-chat entry. It is not a complete conversation
store or arbitrary-language interpreter; creating new tasks belongs to the accepted #3100 preview.

## Run

From this preview worktree (created separately from `~/Jarv1s`):

```sh
pnpm install --frozen-lockfile --ignore-scripts
MANAGE_PREVIEW_PORT=$(devports claim scheduled-manage-design)
pnpm prototype:scheduled-manage --port "$MANAGE_PREVIEW_PORT"
```

Open `/scheduled-task-management.prototype.html`. Optional query parameters:
`state=ready|empty|loading|error` and `task=proposal|news|maya|cleanup|delivery|sale`.
The review toolbar changes sample state and themes, or resets the sample.
Stop the server, then release the port with `devports release "$MANAGE_PREVIEW_PORT"`.

A self-contained clickable HTML copy and screenshot evidence live in the private Moss vault,
alongside the handoff. That copy opens directly in a browser, without a running server.

## Verification and review status

Web typecheck, scoped ESLint and formatting, design-token and UI-class checks passed.
Firefox exercised the management flow in 26 logged steps, including action approval and
discard, pause/resume, deletion in Settings and chat, history inspection, all sample states,
filtering, empty/loading/error recovery, 380px chat, menu focus/Escape, light/dark/Teal and widths
320/375/390/414/768/1280. No horizontal overflow, page errors, network writes or browser storage
were observed. Reload restores fictional samples. Desktop list and phone list/editor screenshots
were visually inspected. The standalone file also passed an open-and-edit check in Firefox.

This is a mockup ready for Ben's design review. It does not implement or prove real persistence,
permissions, scheduling, source reconnection, watch completion or background execution.
No backend, production route, app-map declaration or subsequent design session was changed.
