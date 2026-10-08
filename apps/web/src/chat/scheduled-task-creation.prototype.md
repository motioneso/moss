# Scheduled task creation — throwaway design preview

Question: how should task creation and one-time action approval appear inside Moss chat?

Primary source for [design task #3100](https://github.com/motioneso/moss/issues/3100), based on
[spec #3096](https://github.com/motioneso/moss/issues/3096) at revision `13cd364fe`.
All examples are fictional. State exists only in browser memory and clears on reload. This is
not implementation or proof of scheduling, persistence, permissions or background execution.
Keep this branch out of main. The design is awaiting Ben’s review; no option is accepted yet.

## Compare

One route, three structural presentations, using Moss’s authored tokens and `@moss/ui` controls:

- **A — Conversation:** a plain assistant reply containing timing, destination, actions and the decision.
- **B — Task sheet:** a ruled, labelled task summary inside the transcript.
- **C — Focused review:** a task view inside the existing chat, with a return to the conversation and a saved receipt.

The comparison bar sits outside the proposed product interface. Its arrows and left/right keyboard
shortcuts change `?variant=A|B|C`; typing does not switch layouts. The sample selector and sample
saved count are also review controls, not proposed product features.

The surrounding accepted chat menu stays closed by default and overlays the existing 380px dock
without moving the messages or composer. New side chat is inside the menu and opens directly to
an empty composer. This does not reopen the navigation decision. The original navigation preview
and its files are unchanged; this preview reuses its authored layout stylesheet.

## Run

In the isolated preview worktree:

```sh
pnpm install --frozen-lockfile --ignore-scripts
SCHEDULED_CREATE_PORT=$(devports claim scheduled-create-design)
pnpm prototype:scheduled-create --port "$SCHEDULED_CREATE_PORT"
```

Open the server’s printed address with
`/scheduled-task-creation.prototype.html?variant=A&example=reminder`.
Use `example=watch|suggestion|cleanup` and `view=phone` for other entry states.
Private preview addresses and browser evidence stay in the vault.
After stopping this preview, release its reserved port:

```sh
devports release "$SCHEDULED_CREATE_PORT"
```

The dedicated Vite config scans only this preview entry, with no API proxy or app startup.
The production app does not import this entry. Rendering and comparison controls require Vite’s
development flag. The sample clock is Wednesday 7 October 2026, 2:00 PM PDT.

## Try

Select an example, then send its prefilled request:

1. Reminder or read-and-report inbox watch: saves immediately and shows instruction, local
   timing, destination, actions, and the watch’s three-hour deadline where applicable.
2. Moss suggestion: remains unsaved until agreement. No thanks leaves it unsaved.
3. Inbox cleanup: asks once to approve scoped reading, archiving, permanent deletion and reporting.
   Approve actions & save saves it; Don’t save leaves it unsaved.
4. Switch presentations to inspect the same state. The side-chat destination sample adds an
   explicit request to report in AI reading. Otherwise results go to main chat.

Only the displayed sample requests create a task; arbitrary chat text receives a preview explanation.
Start over resets the demonstration. No source fetching, providers, API mutations, background work,
real authentication or browser persistence are involved.

The creation-time approval wording states that saved tasks run without asking again, refuse other
actions, and respect disabled access. This is explanatory mockup text, not enforcement. Editing
actions would require approval of the new set; changing timing or destination would not. Those
editing controls belong to the separate task-management design session. No runtime approval inbox,
Settings list, update-state screen or preference controls were added.

## Verification

Scoped formatting, lint and web type checks, plus the existing design-token and UI-class checks.
Firefox click-through evidence covers all three layouts on desktop and phone, direct saving,
agreement and decline, approved actions and decline, saved fields, destination, navigation,
keyboard controls, reload reset, light/dark/Teal themes and local-only asset traffic.
The repeatable browser script, screenshots and exact check results are kept in the private vault;
the public design ticket records the final result. No production tests or database gate apply.
