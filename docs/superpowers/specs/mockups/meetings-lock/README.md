# Meetings — sensitive meeting password card mockups

Static design review of the Moss chat password card, generic meeting chooser and
five-minute unlock lifecycle. Follows the password-card sections of
`docs/superpowers/specs/2026-10-27-meetings-home-and-page-redesign.md` on
`origin/meetings-redesign-spec`. No product code, authentication, API, app-map or
security behavior is implemented.

Open [index.html](index.html) from a server rooted at the checkout. From
`~/Jarv1s/.claude/worktrees/meetings-lock-mockups`, use the assigned preview port:

```bash
python3 -m http.server 5184 --bind 0.0.0.0
```

The preview remains running for review until requested otherwise. The mockups
reuse the merged [Meetings review frame](../meetings-redesign/README.md), actual
Park Press tokens, shared primitive CSS, docked chat, paper texture and self-hosted
Archivo. The [approval-card pattern](../../approval-card/README.md) supplies the
calm full-thread card, heading, primary/secondary actions and quiet resolved line.
Bottom screen navigation and theme controls belong to the review frame. The index
includes desktop and 390px phone previews; every state also adapts directly to its
viewport. Phone chat is a drawer over the page.

| Screen                                  | What it shows                                                                                      | Shared primitives represented                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Password](password.html)               | User's question followed directly by a generic card; no meeting content or confirmation            | Card, Field, FormLabel, input, Button, ButtonLink, Thread |
| [Chooser](chooser.html)                 | Generic Meeting rows with permitted date/time and length only; selection precedes password         | Card, RowButton, ButtonLink                               |
| [Wrong password](wrong-password.html)   | Empty masked field, exact inline error, Unlock and Cancel                                          | Field, input error, Button, ButtonLink                    |
| [Retry later](retry-later.html)         | Generic throttling state with Try again and Cancel                                                 | Card, error hint, ButtonLink                              |
| [Cancelled](cancelled.html)             | Quiet Cancelled line, with the question no longer pending                                          | Thread resolved line                                      |
| [Unavailable](unavailable.html)         | Request unavailable; Choose a meeting again                                                        | Card, ButtonLink                                          |
| [Set app password](password-setup.html) | Auth setup handoff when no app password exists                                                     | Card, Button, ButtonLink                                  |
| [Unlocked](unlocked.html)               | Quiet success line, fictional answer, time left, absolute expiry and Lock now                      | Thread, ButtonLink                                        |
| [Expired](expired.html)                 | Prior protected turns replaced with generic placeholders; next explicit question gets a fresh card | Thread, Card, Field, Button                               |
| [Locked now](locked.html)               | Lock now has hidden protected history without immediately asking another question                  | Thread resolved line                                      |
| [Phone drawer](phone.html)              | The pending card in the phone chat drawer                                                          | Thread, Card, Field, IconButton                           |

Review interactions:

- Choose a generic row to open Password. Unmatched and ambiguous references share
  this chooser; it makes no sensitive-match claim or private match count.
- Submit any nonempty field to open Wrong password. Cancel replaces the card with
  the quiet Cancelled line. Retry later returns to Password; unavailable requests
  return to the chooser. The input is masked, uses `current-password`, has no
  preset value and clears on submit, cancel or drawer close. No password fixture
  is defined or compared. Do not enter a real password.
- Open Unlocked using the review navigation to inspect the successful snapshot.
  Its fictional window starts at 10:30 am and ends at 10:35 am; the snapshot shows
  4:32 remaining. These values are frozen, including on reload. They illustrate
  the spec's absolute window; there is no client authentication or running timer.
- Lock now opens Locked now, replacing prior protected messages with generic
  placeholders. Send a new question from that snapshot to inspect the fresh
  password card. Expired is separately linked to review the same conversation
  after the window has ended. Protected answer text is absent from those snapshots,
  rather than merely blurred. No automatic resume or action replay is simulated.
- Other composer submissions open the chooser as a fixed review transition;
  there is no model or message persistence. The Set app password button is an
  inert Auth-handoff illustration. The source timestamp is a static citation.
- Close chat or press Escape to close the drawer; focus returns to Chat with Moss.
  Reopening clears the password field. Phone keyboard focus stays inside the
  drawer; the product background is inert while it is open. Review controls remain
  outside the product frame so the designer can change screens and themes.
- Switch Forest/Canyon and light/dark from the review controls. Index controls
  apply to both embedded previews as well.

The task's no-explanation rule takes precedence over the spec's longer password
card explanation. The heading, field, actions, required error and lifecycle lines
remain; no reassurance or explanatory paragraph appears in the product screens.
Before unlocking, only the user's own question and permitted generic list stubs
appear. Fictional answer text exists only in Unlocked. All people, dates and
content are fictional. These static pages are directly reachable for review and
are not an authentication or confidentiality boundary. The direct-vault exception
and all runtime enforcement remain in the implementation spec.

HTML represents rendered primitive markup rather than mounting React. A future
implementation must use `@moss/ui` components and their lifecycle contracts. Local
JavaScript only moves between fixtures, clears fields, changes review themes and
opens/closes the drawer. No API calls, password verification, persistent writes
or actual meeting access are included.

Verification: Firefox exercised all 11 state screens at 1280 × 800, 1440 × 900,
390 × 844 and 320 × 760 in Forest and Canyon, light and dark: 176 combinations.
Every card spanned the thread width, no page or thread overflow was detected and
all visible chat text met the 11px floor. Cropped drawer captures were inspected
for the pending card, chooser and expired history. Drawer close/Escape and focus
return, field clearing, wrong-password submission, Cancel, chooser selection,
Lock now, the next-question card and index theme propagation all passed. No page
errors or failed assets were observed. The completed browser run exited 0.

`pnpm exec prettier --check docs/superpowers/specs/mockups/meetings-lock`,
`git diff --check` and `pnpm check:ui-classes` passed (exit 0). The scoped shared
class audit found all 15 shared classes defined; all 18 local layout hooks were
also defined. These are fixture checks, not product acceptance or security proof.

These mockups do not start product implementation.
