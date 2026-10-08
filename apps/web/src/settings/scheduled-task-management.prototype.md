# Scheduled task management — throwaway design preview

Design mockup for task #3101, using fictional data and browser-memory state. Source brief:
the Moss vault's `Design previews/Scheduled proactive design sessions/02-manage-tasks.md`.
This branch inherits #3100's accepted ordinary-chat creation preview. Keep it out of main.

Ben's review changed the design to a compact list grouped into Reminders, Daily, Weekly,
More often and Watches. Each row contains only a related flat icon and task title. Completed
and expired records remain inspectable under a collapsed Past tasks section.

Task titles use the authored Archivo display face, with Today-style heading weights.
Clicking a row opens a little information, run history with dated outcomes, and pause/resume
or delete controls. A quiet successful check remains distinguishable from a failed run.
Management actions such as pausing do not appear as task runs.

Ben's detail-screen pass keeps the instruction, status, schedule and useful run results.
Only watches show a stop condition; the default Main chat destination and indefinite duration
are omitted. Past tasks show their recorded outcomes without obsolete scheduling metadata.
Run results omit repeated source labels. Only tasks that change user data disclose their action
scope, so the inbox sample still makes permanent deletion inspectable.

There is no Edit button or editing form in Settings. Users edit schedules through ordinary
Moss conversation, including any approval needed for changed actions. Deleting a schedule
confirms that future work stops while previous messages and completed actions remain.

The sample chat accepts `make AI news weekly` (or `daily`), `pause AI news`, `resume AI news`,
and `delete AI news`, then a typed confirmation for deletion. Cadence edits move the sample
into the corresponding list section. Ordinary replies update the same record shown in Settings. It uses
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
Firefox exercised the revised grouped list, compact details, no Settings edit controls,
run-only history, pause/resume, deletion cancellation/confirmation, chat cadence edits and
section changes, completed/expired inspection, failed-run history, loading/empty/error
recovery, widths 320/375/390/414/768/1280, dark Teal and loaded Archivo. No horizontal overflow,
page errors, network writes or browser storage were observed. The repeatable script and
screenshots remain in the private vault. The original fuller preview is retained in branch
history at c444f83f7; Ben's compact-list and chat-only-editing decisions supersede it.

An independent Impeccable critique and one bounded confirmation scored the page before the
final detail-screen trim 33/40 (Good). Inspectable recorded run results/messages and action scope, keyboard focus,
phone drawer containment/Escape, failure guidance and prose measure were checked. No current
blocking or major issue remained in the tested paths. One minor finding remains: phone chat
covers the selected task context, so changing a task requires recalling its name. Detector
source scan returned zero findings; browser style flags were interpreted against the authored
system. Settled dark contrast passed; premature low measurements were transition artifacts.
The complete critique and independent evidence stay in the private vault.

After the detail-screen trim, the same Firefox flow passed with explicit checks for omitted
routine metadata, retained watch deadlines, inbox action scope and past-task outcomes.
Scoped lint/format, web typecheck and design-token/UI-class checks passed again.

This is a mockup ready for Ben's design review. It does not implement or prove real persistence,
permissions, scheduling, source reconnection, watch completion or background execution.
No backend, production route, app-map declaration or subsequent design session was changed.
