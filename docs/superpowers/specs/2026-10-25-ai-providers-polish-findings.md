# AI providers page: critique, audit and proposed direction

Status: proposal, not approved. Nothing here is built. Follows slice 1 (#3683). Screens captured on
the moss-proof copy at desktop (1440) and phone (390) width, built from main at 0a6bb3c55.

## Findings, ranked

1. **Lock rows break on a phone.** "Lock my chat to one model" is squeezed into a one-word-per-line column next to its select. It also mixes a personal setting into an instance admin page.
2. **The decision model row is the hardest to read.** The select, a second "Chat gate" control with Off/Shadow/On, and two tiny info icons share one right-hand cell, and the label floats to the middle while other rows align top. "Classifier" and "Chat gate" are unexplained.
3. **Wording leaks internals.** "ACP adapter initializes", "Classifier", "Chat gate", "Shadow", "instance default", "Personal -> Your assistant", "Needs configuration".
4. **Three row layouts in one section.** Chat shows its model id twice (select and caption), Email reading has a status line, the decision model has controls on two lines. Rows should share one anatomy.
5. **Provider card has seven small actions.** Log in, Terminal, Edit, delete and a models row with Refresh and Add model all compete. On a phone the models row wraps ("MODELS · 15").
6. **Collapsed sections are fine; expanded ones repeat themselves.** Voice repeats its own heading, three places say keys are stored encrypted and never shown, Save buttons sit greyed, the member search placeholder is cut off.
7. **Missing cue on collapsed groups.** "Not configured" gives no hint it is optional.

Audit: the design detector found nothing in the page's files. Contrast and touch size were judged
by eye, not measured. The info icons and the delete icon look smaller than 44px.

## Proposed direction (mockups in `ai-providers-polish-mockups/`)

- One row anatomy for every job: name and one plain line on the left, one control on the right, a small status under the line only when something is missing. Stacks on a phone.
- Decision model gets its own row. Empty it reads "Not chosen" with two buttons, Choose a model and Ask Moss to help. Choosing opens a dialog that lists every connected model equally, with nothing preselected and no recommendation. The Off/Watch only/On setting moves under an Advanced fold in that dialog and appears only once a model is chosen.
- Moss help opens the chat drawer with a neutral question about what the user needs. It never picks a model.
- Provider card keeps Edit and an overflow menu (Sign in again, Terminal, Remove). Models become one disclosure line with Refresh and Add model inside it.
- The instance-wide lock stays on this page, under a section named "Who can choose the chat model" (the switch plus the instance default). "Lock my chat to one model" is renamed "Lock my own AI to one model" and sits under a "Just for you" heading. Nothing moves to Personal.
- Plain wording throughout. No jargon, no arrows or dashes in labels.

## Open questions

1. Does the self-lock ("Lock my own AI to one model") stay on this page under "Just for you" (recommended) or move to Personal > Your assistant? It is a hard lock on all of that person's AI use, not only chat.
2. Approved: Ask Moss to help opens the chat drawer with a neutral starting prompt.

## What the three controls do (from the code)

| Control | Scope | Effect |
|---|---|---|
| "Let people choose their own chat model" switch | Whole instance | Off: everyone chats with the instance default and Personal shows it read-only. On: people may pick models flagged as allowed. This is the instance-wide lock. |
| Instance default provider | Whole instance | Chat follows its model choice inside this provider. |
| "Lock my chat to one model" | One account (the signed-in admin only) | A hard pin on every AI job that person triggers (chat, voice, background work), not just chat. While set, the person's own chat chooser is rejected with "An admin has pinned your AI provider". |

An admin pins other people from People & access (an "AI pin" per person, a model or a whole provider).
The self-lock overlaps the chooser on Personal > Your assistant, and wins over it.

## Notes carried over from the #3683 review

| Note | Action in the build |
|---|---|
| Five UAT specs and 1270 line 166 use a sign-in window name that never matches (real title is "Sign in to <name>") | Fix the names |
| Proof listed which checks were unit-test only | State it in this PR's proof |
| Slice 1 spec says "No choice is ever disabled" but taken subscription choices are disabled | Reword the spec line to describe the interim rule |
| `provpick__cred-acts` and `provpick__on` styles unused | Delete them |
| Chat lock rows hidden until a provider exists | Keep; show "Add a provider first" under the section instead of nothing |
