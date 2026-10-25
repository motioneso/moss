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
- Chat access keeps only "Let people choose their own chat model". "Lock my chat to one model" moves to Personal > Your assistant.
- Plain wording throughout. No jargon, no arrows or dashes in labels.

## Open questions

1. Where does "Lock my chat to one model" live? A) Personal > Your assistant (recommended, that is where chat model choice already is). B) Stay here.
2. Does "Ask Moss to help" open the chat drawer with a prefilled neutral prompt (recommended, no new backend)? Or A) a guided in-page questionnaire?

## Notes carried over from the #3683 review

| Note | Action in the build |
|---|---|
| Five UAT specs and 1270 line 166 use a sign-in window name that never matches (real title is "Sign in to <name>") | Fix the names |
| Proof listed which checks were unit-test only | State it in this PR's proof |
| Slice 1 spec says "No choice is ever disabled" but taken subscription choices are disabled | Reword the spec line to describe the interim rule |
| `provpick__cred-acts` and `provpick__on` styles unused | Delete them |
| Chat lock rows hidden until a provider exists | Keep; show "Add a provider first" under the section instead of nothing |
