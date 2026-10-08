# Scheduled task creation — throwaway design preview

Accepted design for [task #3100](https://github.com/motioneso/moss/issues/3100): Moss responds
with ordinary text in the existing chat transcript. Ben explicitly clarified that this is not
option A from the earlier comparison. There is no task sheet, special summary, receipt, review
panel or separate approval control.

Examples are fictional and state lives only in browser memory. This does not implement or prove
real scheduling, persistence, permissions or background execution. Keep the branch out of main.

## Accepted conversation

- A specific reminder or read-and-report watch saves directly. Moss confirms naturally, such as
  “I’ll remind you tomorrow, Thursday 8 October, at 9 AM PDT to send Maya the proposal.”
- A Moss suggestion is an ordinary question. The task remains unsaved until the user agrees in
  chat; declining leaves it unsaved.
- A task that changes or deletes data has one creation-time question in ordinary chat text.
  Moss states the scoped actions, including permanent deletion. The user’s agreement saves and
  approves that set; declining leaves it unsaved. Background runs do not ask again.
- Include relevant local timing and stop conditions naturally. Omit redundant default-destination
  and routine-action summaries. Mention an explicitly requested side-chat destination naturally.
- Keep the accepted closed-by-default conversation overlay and the existing 380px dock.

The original A/B/C comparison remains available as a primary source at commit `26dec87bc` on
this throwaway branch. Ben’s final ordinary-text decision supersedes the initial B preference.
The spec and other design sessions will be reconciled separately; this does not authorize
production implementation or work on Settings, update states or preferences.

## Run

```sh
pnpm install --frozen-lockfile --ignore-scripts
SCHEDULED_CREATE_PORT=$(devports claim scheduled-create-design)
pnpm prototype:scheduled-create --port "$SCHEDULED_CREATE_PORT"
```

Open the printed server address with `/scheduled-task-creation.prototype.html?example=reminder`.
Use `example=watch|suggestion|cleanup` and `view=phone` for other samples. Old `variant=` links
now show the same ordinary conversation. Private preview addresses and screenshots stay in the vault.

The dedicated Vite config loads only this preview, with no application startup or API proxy.
The production app never imports it; rendering requires the development flag.
After stopping the preview, release its reserved port:

```sh
devports release "$SCHEDULED_CREATE_PORT"
```

## Try

Use the sample selector, then send the prefilled request. For a suggestion or cleanup request,
reply “yes” or “no” using the normal composer. A reply that changes the proposed actions does
not count as agreement in this demonstration. Start over resets the sample. The selector,
sample saved count, screen-size and theme controls are review tools outside the product chat.

Only the sample requests and simple agreement/decline replies are simulated. Arbitrary text
gets a preview explanation. The sample clock is Wednesday 7 October 2026, 2 PM PDT. Default
results still belong in main chat, including tasks created in side chats; an explicit request
can choose AI reading. The hidden sample state retains the agreed instruction, timing,
destination and actions without displaying a second task interface.

## Verification

Scoped formatting, lint and web type checks, with the existing design-token and UI-class checks.
Firefox checks cover normal-text direct saves, proposals, scoped action/deletion approval,
agreement, decline, ambiguous agreement, destination, normal transcript rendering, preserved
chat geometry, desktop/phone layouts, themes, reload reset and local-only asset traffic.
The repeatable script and compact screenshots are in the private vault; the design ticket
records the final checks. No database or production test suite applies.
