# Finance Budget: "This month" strip and "Needs your attention" list

- Cards: 351 (This month strip, Ready to assign) and 356 (Needs your attention), both under epic 235
- Status: draft, awaiting Ben's approval of the mockups
- Source: Finance critique of 2026-11-01 with populated data (problems 3 and 4, bold changes 1 and 3)
- Builds on: `2026-10-08-finance-redesign-design.md` and the Finance specs of 2026-10-28 to 2026-10-30
- Mockups: `docs/superpowers/specs/finance-redesign/attention.html` (desktop 1440 and phone 390)
- Scope: design only. No product code.

## Summary

Budget opens with the question "how am I doing this month" unanswered and one large number nobody
explains. This spec adds two blocks to the Budget tab and one button.

- The strip shows five figures: income so far, spent, left to spend, bills due, overspent.
- The attention list shows what needs a decision now, each item with a one-tap fix.
- Ready to assign gets an Assign button and a plain label.

The two blocks use the same data and share one read, so they are designed together.

## Placement

| Block                 | Where                                                           |
| --------------------- | --------------------------------------------------------------- |
| Ready to assign       | Hero, as today, plus an Assign button beside the month stepper  |
| Needs your attention  | Directly under the hero, full width. Absent when empty          |
| This month            | Under the attention list, full width, above the category groups |
| Balances              | Right rail on desktop, as today                                 |
| Old "Needs you" tiles | Removed. The list replaces them                                 |

The list lives on Budget only. Budget is the landing tab, and a copy on Transactions or Accounts
would repeat the same rows. Both blocks show for the current month only. Past and future months
show the strip without the attention list, since nobody can fix last month's bill.

## Screen states

All states are in the mockups. Every state exists at desktop and phone width.

| State      | Mockup                   | What it shows                                                                                   |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| Normal     | `07-attention-normal`    | Two bills, one grouped prediction row. Overspent tile reads None                                |
| Overspent  | `08-attention-overspent` | Dining out over. Overspent row leads the list. Overspent tile turns warm and names the category |
| Many items | `09-attention-many`      | Past due bill, three overspent rows, a fixed row with Undo. Five rows show, the rest hide       |
| Empty      | `10-attention-empty`     | No list at all. The strip stays. Ready to assign reads $0.00                                    |

Further states, described here and not drawn because they reuse drawn parts:

- **Loading.** Strip tiles show a grey bar where the value goes. The list is absent until the
  read returns. The Ready to assign value shows `$––.––` as it does today.
- **Read failed.** The strip tiles show a dash and a Retry button replaces the list. A failed
  read never shows zeros, because a zero reads as good news.
- **Month start, day one.** Spent is $0.00, Left to spend equals what was assigned, Bills due
  shows the whole month. The list still shows bills due this week.
- **Ready unavailable.** When Budget already reports Ready as unavailable (a card ledger needs
  review, or an account has no balance), the Assign button is disabled and the strip is
  unaffected.
- **Setup required (no currency chosen).** Neither block shows.

### Desktop layout

The attention list runs in two columns so a long list does not push the strip off the screen.
Rows fill left to right, top to bottom. The strip runs five tiles across the full width. Groups
and the Balances rail follow as today.

### Phone layout

One column. Each row stacks its text over its buttons, and buttons are 44px tall. The strip is a
full-width Income tile over a 2 by 2 grid. The list shows at most five rows before "Show N more", never a scroll box.

## The strip

Five tiles, always in this order. Figures are for the month on screen and use Budget's existing
currency. All of them come from data the Budget read already returns or from the bills read.

| Tile          | Value                                                               | Sub-line                                    |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Income so far | Sum of deposits in the Income group this month (transfers excluded) | "N deposits"                                |
| Spent         | Sum of activity across spending categories, shown as a positive     | "of $X assigned"                            |
| Left to spend | Sum of the positive available amounts across spending categories    | "across N categories"                       |
| Bills due     | Expected amount of bills not yet posted or skipped this month       | "N bills, next Fri Oct 10"                  |
| Overspent     | Sum of negative available amounts. "None" when there are none       | Names the worst category, or "0 categories" |

Income so far uses the Income group's activity, which Budget already returns, so it needs no new data. It is not tappable. Spending categories are every category except the Savings and Income groups, which the taxonomy
already separates. Transfers are excluded, as Ready to assign already excludes them.

Rules:

- Left to spend ignores overspent categories. They show on the Overspent tile and nowhere else, so
  one overspent category does not silently reduce a figure the user reads as "safe".
- Money set aside for a later bill counts in Left to spend. Car insurance with $210 available
  and nothing posted counts. This matches how the category rows read today.
- The Overspent tile turns warm only when the figure is negative, and does not change when the
  user taps it.
- Tapping Overspent scrolls to the first overspent row, as the old tile did. Bills due opens
  Upcoming. Spent and Left to spend are not tappable.
- Past months use the same definitions on that month's figures. Bills due then counts bills that
  were never posted, labelled "unpaid".

## Ready to assign

The big number stays. The critique's complaint is that it is unexplained and has no action. The
fix is a label and a button, with no sentence on screen, to follow the screen-copy rule.

- The hero line under the number reads "Not in a category yet". On phone it is dropped for space
  and the Assign button carries the meaning.
- The **Assign** button sits beside the month stepper.
- Assign opens the existing target-funding dialog, which already lists underfunded categories,
  puts overspent ones first, and saves through the reviewed-and-confirmed path. With no targets
  set, the dialog falls back to a category picker and an amount, prefilled with all of Ready.
- Assign is disabled, with no tooltip, when Ready is zero, negative, or unavailable. A negative
  Ready is a different problem and the Overspent row covers it.

## The attention list

### What qualifies

| Kind        | Qualifies when                                                                | Source                                      |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| Bill        | Past due, or due within 7 days including today, and not posted or skipped     | Bills read, occurrences                     |
| Bill, match | The bill has a posted transaction that fits and the occurrence is in "review" | Bills read, state "review"                  |
| Overspent   | A spending category has negative available this month                         | Budget read, category state                 |
| Predicted   | A transaction has a guessed category the user has not confirmed               | Budget read, `needsLookCount`, Transactions |

### Order

1. Past due bills, oldest first.
2. Overspent categories, largest overspend first.
3. Bills due this week, soonest first.
4. Predicted categories, as one grouped row.

Money already out the door (past due) and money already negative (overspent) outrank things that
can wait a few days.

### Grouping and the cap

- Several predicted transactions collapse into one row ("3 predicted categories"). One predicted
  transaction shows as itself.
- Bills and overspent categories always get their own row.
- The list shows at most five rows. The remainder sits behind
  "Show N more", which expands in place. The heading counts everything, including hidden rows.

### Row anatomy

Badge for the kind, one line of what, one line of detail, then the buttons. The badge tones come
from the Park Press set already used in Transactions (red for past due and overspent, amber for
predicted and for a bill with a match to confirm, neutral for a bill due on time).

## One-tap fixes

"One tap" means one tap to do the fix, with Undo available afterwards. The table is honest about
which fixes need more.

| Row                      | Button         | What it does                                                                                        | Taps |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------- | ---- |
| Bill with a fitting post | Match $X       | Matches the bill to the posted transaction (`finance.bill.decide`, state matched)                   | 1    |
| Bill, nothing posted     | Record payment | Opens the existing record-payment dialog with account, amount and date prefilled. The user confirms | 2    |
| Bill, any                | Skip           | Skips this occurrence (`finance.bill.decide`, state skipped)                                        | 1    |
| Bill, any                | Open           | Opens the bill's detail panel, as Upcoming does                                                     | 1    |
| Overspent                | Cover from X   | Moves the overspent amount from the category with the most left, using `finance.budget.move`        | 1    |
| Overspent                | Pick another   | Opens a source picker, then moves                                                                   | 2    |
| Predicted, grouped       | Confirm all N  | Confirms every guess in the group (`finance.transactions.confirm`)                                  | 1    |
| Predicted, grouped       | Review         | Opens Transactions filtered to "Needs a look"                                                       | 1    |
| Predicted, one           | Confirm        | Confirms that guess                                                                                 | 1    |

Details that matter:

- **Cover from X** names the source category in the button, so the user sees where the money
  comes from before tapping. The source is the non-savings category with the most available that
  can cover the full amount. When none can cover it in full, the button reads "Cover part from X"
  and moves what X has.
- **Cover from X** moves money, so it follows Finance's freedom setting. At or under the
  user's dollar limit it just runs. Over the limit it shows the same ask-first confirmation Moss's
  own moves show. This spec does not add a second rule.
- **Confirm all N** accepts Moss's guesses as given. It never changes a category. A transaction
  with no guess at all cannot be one-tapped. It appears under Review.
- **Record payment** is two taps because Finance cannot invent a transaction without the user
  agreeing the amount and date. It is the existing dialog, not a new one.
- After a fix lands, the row stays in place in a muted state with an Undo button for 10 seconds,
  then leaves the list. The row never vanishes under the user's finger. The "many items" mockup
  shows one.
- Undo reverses by the existing mechanism for that action (the activity list already offers
  Undo for confirms and moves). Matches and skips undo with `finance.bill.clear`.
- Every fix refreshes the strip, the hero and the list from one read, so the numbers never
  disagree for a moment.

## Edge cases

| Case                                        | Behaviour                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Same bill past due and due again this week  | Two rows, one per occurrence                                                                |
| Bill with a one-off changed date            | Uses the changed date for "due this week" and the row detail                                |
| Overspent category and nothing can cover it | Button disabled, detail line reads "No category has enough". Pick another stays             |
| Cover amount over the freedom limit         | Existing ask-first confirmation                                                             |
| A fix fails or the write is uncertain       | The row returns to its normal state and the existing "Check saved records" notice appears   |
| Two tabs open and one fixes a row           | The other tab's next read drops the row. A second tap on a stale row reports "already done" |
| Bank sync stale for an account              | Bills and predicted counts still show. The Balances rail keeps its stale marker             |
| Card ledger needs review                    | Ready is unavailable. Overspent and bills still show. Assign is disabled                    |
| Foreign currency accounts                   | The strip uses the one working currency Budget already chooses. Other accounts do not count |
| Pending (not yet posted) transactions       | Not counted, matching Budget's existing "pending not counted yet" note                      |
| Day-one month, nothing spent                | Spent $0.00. Overspent None. The list can still hold bills                                  |
| Predicted transactions from earlier months  | They count. "Needs a look" is not month-scoped in Transactions                              |
| Household shared pool                       | Out of scope. Personal figures only, as Budget is today                                     |

## Data

Everything uses existing Finance data. Four gaps the build should confirm before it starts.

1. **Bills due this week on Budget.** The Budget read does not return bills. The build either
   adds a small "due soon" section to the Budget read or the screen calls the bills read for
   today through today plus 7 days. Preferred: one extra call in the same refresh, since the
   bills read already returns the occurrence states this spec needs.
2. **Predicted transactions by name.** Budget returns `needsLookCount` only. The grouped row names
   up to three payees, so it needs a short list from the Transactions query (already available,
   filtered to needing a look). Without it the row shows only the count.
3. **Cover source.** Picking the category with the most available is computed on the screen from
   the category states Budget already returns. No new data.
4. **Uncategorised.** The critique said "uncategorised". Finance has no uncategorised state for
   a synced transaction, because Moss always guesses. The list covers the guess waiting for a
   look, which is the real equivalent. An imported or manual row with no category needs the
   category picker, so it appears only under Review, never as a one-tap fix.

No new tables, no migration, no secrets.

## App map changes

Core screen text and module metadata must change in the same PR as the build.

- `external-modules/finance/jarvis.module.json`, screen `finance.budget`: add that the This month
  strip shows Spent, Left to spend, Bills due and Overspent, that Needs your attention lists bills
  due within 7 days, overspent categories and predicted categories with one-tap fixes, that
  Assign opens target funding, and that both blocks show for the current month only.
- Same file, `features`: add one feature for the attention fixes (Match, Skip, Cover from,
  Confirm all) naming Undo, and the freedom-limit rule for Cover from.
- Remove the old "Needs you" tiles wording from the Budget description.

No change to `packages/shared/src/app-map-core.ts`, since Finance is a module.

## Screen-copy check

The screens carry labels and facts only. No explanation or reassurance lines. Two judgement calls
for review:

- "Not in a category yet" under the Ready to assign number is a short label, not a sentence. The
  card asked for a one-line explanation, and the screen-copy rule forbids explanatory lines.
  This is the middle path.
- Sub-lines such as "of $3,572.00 assigned" and "2 bills, next Fri Oct 10" are facts.

## Accessibility and layout

- Each button has the row's name in its accessible label ("Match $48.40, Harbor Water").
- Heading counts are text, not colour alone. The warm Overspent tile also changes its value to a
  negative figure.
- Tap targets are 44px on phone. No button crowds a neighbour, with 8px minimum between buttons.
- The list follows the horizontal-space rule. Two columns on desktop, full width on phone.

## Out of scope

- Moss chat answering "what needs my attention" (the data is the same, a later tool).
- The Today money line (R2).
- Push alerts for these items (R2).
- Charts and the Reports changes from the critique.
- Household shared budget.

## Build slicing

One slice is enough, since the two blocks share a read.

1. Strip and Ready to assign button, with the app map text.
2. Attention list, the fixes, Undo, and the app map text.

Both land in one PR. Live-path proof must exercise Match, Skip, Cover from, Confirm all and Undo
on a real dev instance, with real data and no intercepted responses.
