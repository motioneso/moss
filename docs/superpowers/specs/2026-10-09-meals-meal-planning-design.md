# Meals: weekly meal planning, pantry and shopping list

**Status:** Final (2026-10-25), after Ben's review and a user-story review  
**Issue:** #3317  
**Terms:** the Meals and meal planning section of CONTEXT.md. ADR 0011 (shared Kitchen).  
**Primary verification seam:** install Meals, set up a household, generate a week, swap and lock
meals, build the shopping list, mark items bought, then mark a meal cooked, all through the Meals
page and again through Chat

## Problem Statement

The Food module today is a food log. A user tells Moss what they ate, Moss estimates calories and
macros, and the Food page shows one day at a time. That is useful for a few people and offers little to
everyone else.

The harder weekly job is deciding what to cook. A person or a household has to pick meals that fit
everyone's restrictions, preferences and calorie targets, use what is already in the kitchen, write
a shopping list with sensible amounts, and keep the pantry honest afterwards. Moss cannot help with
any of that today.

Melio (agent.meal-plan.app) shows the shape of a good answer. It splits a calorie target across
meals, writes each meal with AI, checks nutrition, and sums the ingredients into a shopping list.
It plans for one person only, ignores what is on hand, and forgets everything once the week ends.

## Module distribution model

Meals is a distributable module that is not installed by default, built only on public module
platform contracts, as ruled in the #926 spec. It replaces the Food module rather than sitting
beside it. The new module id is `meals`, and the `food` module is removed from the repository. No
install needs an in-place data upgrade (see Existing data).

## Planning Constraint (binding)

This spec and its plan contain only Meals module-package work: manifest, owned SQL and migrations,
services, repositories, UI, assistant tools, jobs, export and deletion declarations, and tests.
Any missing core-platform capability becomes a separate issue with its own approved spec that
blocks the Meals path it gates. Discovering a new gap mid-build pauses the affected path and files a
blocker. It never licenses a core edit inside the Meals plan.

## Existing data

No deployment has Food installed except Ben's, and Ben's logged rows are disposable. Meals does
not preserve or migrate existing food log data. Ben's deployment removes the old module through the
existing admin module purge, which drops its tables and jobs. Meals may reuse the old estimator
code freely. Food logging stays a feature of Meals, rebuilt to fit the new design rather than
carried over unchanged.

## Platform Blockers

Verified 2026-10-09 against GitHub and the repository.

**Blocks all of this spec (live-path gate):**

- **#1694 (OPEN). Downloaded-module data export.** Meals' export declaration must cover every new
  table listed under Implementation Decisions, including the rebuilt log tables. Deletion is
  already structural through owned tables.

**Blocks only the photo paths (receipt photo in phase 2, fridge photo in phase 3):**

- **#1695 (OPEN). Module attachment upload and binary read.**
- **#1696 (OPEN). Structured-AI image input.**

Receipt text pasted into Chat works in phase 3 without either blocker.

**Blocks only per-task model choice (new issue, to be filed):**

- **Module AI tasks in the AI settings pane.** A module can pass only a tier hint, never a model.
  The resolver already honours a binding for the service `module.<id>`, but the admin pane lists
  only Chat and Email reading, and there is no way to bind one task inside a module. Meals needs a
  manifest declaration of named AI tasks (service `module.meals.<task>`, with tier and capability)
  that the AI settings pane lists and binds, falling back to `module.meals`, then the instance
  default. Until this lands every Meals task uses the instance default routing.

**Blocks only phase 5 sharing (new issue, to be filed):**

- **Cross-user Kitchen data access.** The module RLS emitter applies an owner-only policy to every
  operation on every owned table. A Kitchen shared by two users needs a declared policy shape where
  rows keyed by a Kitchen are visible to every accepted Kitchen member, with membership itself
  owner-controlled. This is a platform contract, not Meals code.

**Retired, verified already covered:**

- **#1699 (CLOSED).** The module page can execute the module's reversible write tools, so every
  page action in this spec goes through module tools.
- **Scheduled module jobs.** Modules can already declare cron schedules, which phase 5's weekly
  draft uses.
- **Job payload keys.** Plan and day jobs carry only ids already allowed by the metadata-only
  payload allowlist.

Blockers gate stages. Planning and build may proceed against an approved contract. A path counts
Done only when every core capability it uses is merged and proven live.

## Solution

Meals is a weekly meal planner for one person or a household, with a rebuilt food log as one part
of it.

A user describes their household once. Each Household member has a Meal pattern, restrictions,
preferences, an optional calorie target and an optional link to a Moss account. The user then asks
for a plan, a week by default or any number of days. Moss writes the Meal plan day by day, showing progress as each day fills in. Meals are
Shared meals by default, sized per eater, and a member can have a One-off meal. Every meal passes a
Safety check against every eater's restrictions before the user sees it.

The user can lock meals they like, swap any meal for one of two or three alternatives, and
regenerate the rest. Moss writes a Shopping list by adding up every ingredient, subtracting what
the Pantry holds, rounding up to a Purchase amount and grouping lines by store section. Each line
remembers which meals need it. Ticking lines and marking the list Bought moves the food into the
Pantry. Marking a meal cooked takes its ingredients out of the Pantry, offers to log a portion in
the food log and asks for a quick Rating.

Everything works through Chat as well as through the page. The page is a front end over the same
module tools.

Delivery runs in five phases. Phase 1 is a clickable prototype of every screen, and its outcome may
change the later phases.

## Phases

### Phase 1. Clickable prototype (gates everything after it)

- A standalone, clickable prototype of every screen and state in phases 2 to 5, at desktop and
  narrow widths. It runs on fake data with a static navbar and is not wired into Moss. There is no
  separate static mockup step.
- Interactions that set the feel are real in the prototype: the plan filling in day by day with its
  writing animation, swap choices, locking, ticking and marking the list Bought, Mark cooked and
  Rating, and the mid-week re-plan and quick swap. Responses are canned, with no AI or storage.
- It uses Moss's look so the agreed design carries into phase 2 directly.
- Screens covered are Plan, Shopping list, Pantry, Household, Log, recipe detail, swap choices,
  generation progress, Mark cooked, Rating, receipt review, empty states and failure states.
- Ben reviews them. The spec's later phases are re-checked against the agreed prototype before
  ticket breakdown of phase 2. Any change is written back into this spec.

### Phase 2. Core planning

- Household members with Meal pattern, restrictions, preferences, optional calorie target and
  stored account link. Planning for just yourself needs no household setup.
- On-demand Meal plan, seven days by default or any number of days the user names, generated day by day with visible progress and a small, tasteful
  animation.
- Safety check with automatic regeneration of failing meals.
- Shared meals sized per eater, One-off meals, plain-text slots ("eating out", "leftovers").
- Locked meals, regenerate the rest, no regenerate limit.
- Two or three swap choices per meal.
- Calorie-fit line per meal and per day for each eater with a target.
- Cook-time limit per night.
- Favourites labelled with whose they are. No repeats of last week's meals unless asked. Repeats
  within a plan are allowed when the user asks for a pattern or meal prep.
- Full recipes with original ingredient text kept beside parsed amounts. Servings start scaled to
  the eaters and the user can change them on any meal.
- A short check-the-label note on any ingredient that names a brand or packaged product.
- Pantry with three modes: ignore, prefer on hand then top up (default), cook only from on hand.
- Staples list, visible and editable.
- Shopping list built by deterministic aggregation, with Purchase amounts, store sections, manual
  items, lines that remember their meals, unconvertible units on their own lines, structured
  ordering fields and check-off times.
- Bought moves ticked lines into the Pantry with edited amounts.
- Leftovers, opt-in, stored as Pantry items (phase 3).
- Mark cooked removes ingredients from the Pantry and offers to log a portion.
- Ratings per member, asked after mark cooked, skippable.
- Favourites per person.
- Receipt by Chat text in phase 3. Receipt photo when #1695 and #1696 land.
- Units configurable, default US.
- AI unavailable means generation fails with a retry. Everything else works.
- Food log rebuilt as the Log area of Meals. Old log data is not kept.

### Phase 3. Pantry smarts

- Expiry dates, with default shelf lives for fresh, frozen and opened food.
- Plans favour food that is about to expire.
- Storage places, including the freezer.
- Staples that go on the list when low.
- Recurring restock items.
- Fridge photo to fill the Pantry (#1695, #1696).
- Undo and history for Pantry changes.
- Per-food unit conversions, so a recipe's 300 g of onion becomes 2 onions on the list.
- Substitutes when an ingredient is missing.

### Phase 4. Learning and money

- Ratings shape future plans. A view shows what Moss has learned about each member.
- Suggestions of Favourites not cooked lately.
- Weekly budget with cost estimates.
- Rebalance the rest of the week after a change.
- Recipe import from a link or a photo.
- Shopping list sorted in store-walk order, learned from tick-off order.
- USDA nutrition cross-check. Large gaps are flagged. It never overrides the estimate.

### Phase 5. Sharing and automation

- Shared Kitchen per ADR 0011 (needs the new cross-user Kitchen blocker).
- Live sync of plan and list between Kitchen members.
- Pings and reminders.
- Opt-in weekly auto draft.

Grocery ordering is a separate later project. The structured ordering fields on list lines exist
so that project can use them.

## User Stories

### Household

1. As a user, I want to plan either for just myself or for a household, my choice, so that a single
   person gets value immediately and a family can still add everyone.
2. As a user, I want to add Household members by name, so that the plan covers everyone I cook for.
3. As a user, I want each member to have a Meal pattern, so that one person can have breakfast,
   lunch and dinner while another has only dinner.
4. As a user, I want the default Meal pattern to be breakfast, lunch and dinner, so that setup is
   quick.
5. As a user, I want to name meals in a pattern freely ("second breakfast", "post-gym"), so that the
   plan matches how we actually eat.
6. As a user, I want to record each member's restrictions, so that no planned meal breaks them.
7. As a user, I want to record each member's preferences, so that plans lean toward what they enjoy.
8. As a user, I want restrictions treated as hard rules and preferences as soft ones, so that
   safety never loses to taste.
9. As a user, I want the option of giving a member a calorie target, so that their portions fit it
   when I care to set one.
10. As a user, I want my own member record to hold my nutrition targets, so that I set them once.
11. As a user, I want to link a member to another Moss account, so that sharing can build on it
    later.
12. As a user, I want to edit or remove a member, so that the household stays current.
13. As a user, I want to do all of this through Chat, so that I never have to open the page.

### Generating a plan

14. As a user, I want to ask for a plan starting on a date I choose, for seven days or any number
    of days I name, so that it fits my week.
15. As a user, I want to see each day fill in as it is written, so that I know it is working.
16. As a user, I want a small animation while a day is being written, so that the wait feels alive
    without being noisy.
17. As a user, I want to read finished days while later days are still being written, so that I can
    start reviewing early.
18. As a user, I want meals shared by everyone eating at that time by default, so that we cook once.
    18a. As a user, I want to mark each meal in the pattern as Shared or Solo, with an optional weekday
    rule, so that, for example, weekday lunches are planned separately per person while dinner is
    one meal for both of us.
    18b. As a user, I want Solo meals planned per person on their own, so that my packed lunch and my
    partner's lunch can differ.
    18c. As a user, I want to override Shared or Solo for any single day, so that a weekend lunch
    together is easy.
19. As a user, I want shared meals sized per eater, so that each person's portion fits them.
20. As a user, I want to give one member a One-off meal, so that someone with different needs is
    covered.
21. As a user, I want to set a slot to plain text such as "eating out" or "leftovers", and change
    it later, so that Moss does not plan a meal we will not cook even when plans shift.
22. As a user, I want to set a cook-time limit for a night, so that busy evenings get quick meals.
23. As a user, I want to see how each meal fits each eater's calorie target, so that I can judge
    the plan at a glance.
24. As a user, I want a day total per eater, so that I can see whether a day runs over.
25. As a user, I want no meal from last week repeated unless I ask, so that we do not get bored.
26. As a user, I want Favourites labelled with whose they are, and repeats allowed when I ask for a
    pattern or meal prep, so that favourites appear without taking over.
27. As a user, I want to tell Moss to repeat something from last week, so that a hit can return.
28. As a user, I want the plan to use food from the Pantry according to my Pantry mode, so that I
    waste less and buy less.
29. As a user, I want to choose ignore, prefer on hand, or only on hand for each plan, so that I
    can do a clear-out week.
30. As a user, I want a day Moss could not finish writing to show a retry button, so that one
    failed attempt does not lose the rest of the week.
31. As a user, I want a clear message when AI is unavailable, while the rest of Meals keeps working,
    so that I can still use my list and pantry.
32. As a user, I want to cancel a plan that is still being written, so that I can change my mind.

### Safety

33. As a user, I want every meal checked against every eater's restrictions before I see it, so
    that I never get an unsafe meal.
34. As a user, I want a failing meal rewritten automatically, so that I do not have to fix it.
35. As a user, I want a slot that cannot be made safe to show as failed with a retry, so that Moss
    never shows an unsafe meal as a fallback.
36. As a user, I want a short note on uncertain ingredients like brands, so that I do not assume a
    suggested brand was already checked.
37. As a user, I want swaps, regenerations and imported Favourites to pass the same check, so that
    every path is safe.

### Changing the plan

38. As a user, I want to lock a meal, so that regenerating keeps it.
39. As a user, I want to regenerate all unlocked meals, so that I can try again without losing the
    ones I like.
40. As a user, I want to regenerate a single day or a single meal, so that small changes are cheap.
41. As a user, I want no limit on regenerations, so that I can keep going until it is right.
42. As a user, I want two or three swap choices for a meal, so that I pick a replacement rather
    than gamble.
43. As a user, I want to change who eats a meal, so that the plan follows real life.
44. As a user, I want to move a meal to another day or slot, so that I can rearrange the week.
45. As a user, I want to put a Favourite into a slot myself, so that I can plan around it.
46. As a user, I want the Shopping list to update when the plan changes, so that it never goes
    stale.
    46a. As a user, I want to re-plan the days that have not happened yet mid-week, leaving past days
    alone, so that the plan recovers when the week goes off course.
    46b. As a user, I want a mid-week re-plan to favour what is in the Pantry now, so that food bought
    for skipped meals gets used.
    46c. As a user, I want to tell Moss something like "I don't have much energy tonight, I need a
    15-minute meal" in Chat, so that tonight's meal is swapped for a quick one without opening the
    page.
    46d. As a user, I want a quick swap to prefer on-hand ingredients and show what, if anything, I
    still need to buy, so that I can decide on the spot.

### Recipes and Favourites

47. As a user, I want each meal to have a full recipe with ingredients, steps, cook time and
    servings, so that I can cook it.
48. As a user, I want ingredient amounts scaled to the eaters as a starting point, and to change
    the servings myself, so that I cook the right quantity.
49. As a user, I want the original ingredient wording kept beside the parsed amount, so that nothing
    is lost when parsing is imperfect.
50. As a user, I want units shown in my chosen system, defaulting to US, so that amounts make sense.
51. As a user, I want to mark a meal as a member's Favourite, so that Moss can bring it back.
52. As a user, I want to see and remove Favourites per person, so that the list stays honest.

### Shopping list

53. As a user, I want a Shopping list built from the plan, so that I do not write it myself.
54. As a user, I want the same ingredient across meals added together, so that I see one line.
55. As a user, I want what is in the Pantry subtracted, so that I do not buy what I have.
56. As a user, I want amounts rounded up to a Purchase amount, so that the list matches what shops
    sell.
57. As a user, I want lines grouped by store section, so that I shop faster.
58. As a user, I want each line to show which meals need it, so that I can drop a meal and know
    what to skip.
59. As a user, I want amounts in units that cannot be converted kept on their own lines, so that
    Moss never guesses wrongly.
60. As a user, I want to add, edit and delete manual items, so that the list covers more than the
    plan.
61. As a user, I want Staples that are missing added to the list, so that basics do not run out.
62. As a user, I want to tick lines as I shop, so that I track progress.
63. As a user, I want to mark the list Bought, editing the amount I actually got, so that the
    Pantry is right.
64. As a user, I want Bought lines moved into the Pantry, so that I do not type them twice.
65. As a user, I want to tell Moss in Chat what I bought, or paste a receipt's text, and have Moss
    update the Pantry, so that a shop made without the list still counts. (Receipt text: phase 3.)
66. As a user, I want to photograph a receipt for the same result, once Moss can read images, so
    that I do not type.
67. As a user, I want the list to keep store-neutral structured fields, so that a later ordering
    feature can use it.

### Pantry

68. As a user, I want to see everything in the Pantry with optional amounts, so that I know what I
    have.
69. As a user, I want to add, edit and remove Pantry items by hand and through Chat, so that it
    stays accurate.
70. As a user, I want amounts to be optional, so that "some rice" is enough.
71. As a user, I want a visible, editable Staples list, so that I control what counts as basic.
72. As a user, I want Leftovers saved as Pantry items when I choose, so that they get eaten.
    (Phase 3.)

### Cooking, logging and Rating

73. As a user, I want to Mark cooked, so that the Pantry loses what the recipe used.
74. As a user, I want Mark cooked to offer to log my portion, so that tracking costs one tap.
75. As a user, I want the logged portion to use the existing estimator, so that numbers match the
    rest of my log.
76. As a user, I want to Rate a meal per eater after cooking, skippable, so that Moss learns.
77. As a user, I want a one or two star Rating from any eater to nearly veto a meal, so that we
    default to pleasing everybody.

### Food log

79. As a user, I want to log what I ate through Chat and the Log area, so that tracking works.
80. As a user, I want the Log area to show a day view with totals and corrections, so that I can
    see and fix what I ate.

### Chat parity

81. As a user, I want to ask "what's for dinner tonight?", so that I get the answer without opening
    Meals.
82. As a user, I want to plan, swap, lock, regenerate, edit the list and update the Pantry through
    Chat, so that every page action has a Chat equivalent.
83. As a user, I want Chat and the page to change the same records, so that they never disagree.

### AI model choice

83a. As a user, I want Meals to use the instance's default AI provider and model unless I say
otherwise, so that it works with no setup.
83b. As an administrator, I want to pick a model for Meals' plan writing separately from the
instance default, so that, for example, Claude writes meal plans while Codex stays the default
everywhere else.
83c. As an administrator, I want to pick models separately for these Meals tasks, each falling back
to Meals' choice and then the instance default, so that cheap work stays cheap: - plan writing and regeneration (reasoning tier by default) - quick swaps and Chat requests such as "15-minute meal tonight" (interactive tier) - nutrition estimates for the log and calorie fit (economy tier) - receipt and fridge photo reading (needs a vision-capable model)
83d. As a user, I want the page to say which model wrote a plan when a task has its own model, so
that I can compare results.

### Phase 3 pantry smarts

84. As a user, I want expiry dates with sensible defaults for fresh, frozen and opened food, so that
    I know what to use first.
85. As a user, I want plans to favour food about to expire, so that less goes in the bin.
86. As a user, I want storage places including the freezer, so that I know where things are.
87. As a user, I want Staples added to the list when low, so that I restock in time.
88. As a user, I want recurring restock items, so that weekly basics appear automatically.
89. As a user, I want to photograph my fridge to fill the Pantry, so that setup is fast.
90. As a user, I want to undo Pantry changes and see their history, so that mistakes are cheap.
91. As a user, I want Moss to know how much one of a food weighs, so that a recipe asking for
    300 g of onion puts 2 onions on the list.
92. As a user, I want substitutes suggested when something is missing, so that I can still cook.

### Phase 4 learning and money

93. As a user, I want Ratings to shape future plans, so that plans get better each week.
94. As a user, I want to see what Moss has learned about each member, so that I can correct it.
95. As a user, I want Favourites not cooked lately suggested, so that good meals return.
96. As a user, I want a weekly budget with cost estimates, so that plans fit what I can spend.
97. As a user, I want the rest of the week rebalanced after a change, so that totals stay on target.
98. As a user, I want to import a recipe from a link or a photo, so that my own recipes join plans.
99. As a user, I want the list sorted in the order I walk the store, learned from how I tick, so
    that shopping is quicker.
100.  As a user, I want nutrition estimates cross-checked against USDA data, with large gaps
      flagged but never overridden, so that one outdated source cannot mislead the plan.

### Phase 5 sharing and automation

101. As a Kitchen owner, I want linking a member to another Moss user to send them an invite, so
     that nobody joins without agreeing.
102. As an invited user, I want to accept or decline, so that I choose whether to share.
103. As a joining user, I want my own Kitchen put away rather than deleted, and to copy Pantry items
     in first, so that I lose nothing.
104. As a leaving user, I want my old Kitchen back, so that I can carry on alone.
105. As a Kitchen owner, I want to be the only one who invites people in, removes people and
     deletes the shared Kitchen, so that control over who shares it is clear.
106. As a Kitchen member, I want to edit members, Pantry, plans and lists, so that we share the work.
107. As a Kitchen member, I want my own food log to stay private, so that sharing a kitchen does not
     share my eating record.
108. As a Kitchen member, I want changes from others to appear live, so that we do not shop twice.
109. As a user, I want pings and reminders, such as defrost tonight, so that the plan happens.
110. As a user, I want an opt-in weekly draft plan, so that next week is ready without asking.

### Privacy, export and lifecycle

111. As a user, I want my Meals data in my data export, so that I own it.
112. As a user, I want account deletion to remove all my Meals data, so that nothing lingers.
113. As a user, I want disabling Meals to hide it while keeping my data, so that I can come back.
114. As a user, I want no other user, including an administrator, to read my Meals data, so that it
     stays private.

## Implementation Decisions

### Module shape

- Module id is `meals`, a fresh module with its own migrations from version 1. Nothing is carried
  over from `food`. Migrations keep the one-statement-per-file convention.
- The page gets five areas: Plan, Shopping list, Pantry, Household, Log. Log is a rebuilt day view
  with totals and corrections. The page uses a new `mls-` CSS prefix and calls module tools only.
- Tool families are `meals.household.*`, `meals.plan.*`, `meals.list.*`, `meals.pantry.*`,
  `meals.recipes.*` and `meals.log.*`. Queues, settings keys and activity labels use the `meals.`
  prefix too.
- Every tool is reachable from Chat and the page. Read tools return structured records. Write tools
  are reversible where possible. Deleting a plan, a member or the whole list follows the existing
  destructive-tool confirmation flow.

### Data model

Every new table carries `owner_user_id` and `kitchen_id` from day one (ADR 0011). Every new table
is listed in owned tables so deletion and owner-only RLS are generated. In phases 2 to 4 the
Kitchen always has exactly one member, its owner.

- **kitchens.** One per user, created lazily. Holds units system and default Pantry mode.
- **household_members.** Name, optional linked account email (typed, resolved to an account in
  phase 5, because a module cannot look up other users), optional calorie and macro targets, Meal pattern
  (ordered list of named meals), restrictions, preferences, `is_self`.
- **meal_slot_rules.** Kitchen-level rule per named meal: `shared` or `solo`, with optional weekday
  set (for example lunch is `solo` Monday to Friday, `shared` at weekends). Default `shared`.
- **meal_plans.** Start date, Pantry mode, status, generation run id.
- **plan_days.** Date, status (`pending`, `writing`, `ready`, `failed`), progress, failure reason,
  optional cook-time limit.
- **planned_meals.** Day, slot name, kind (`recipe`, `text`), sharing (`shared`, `solo`), eaters,
  `locked`, `one_off_for`, favourite source, servings override, calorie fit per eater, recipe reference, plain text.
  A `solo` slot produces one planned meal per eater; a per-day override changes `sharing` for that
  slot on that day only.
- **recipes.** Title, steps, cook minutes, base servings, source (`generated`, `favourite`,
  `imported`).
- **recipe_ingredients.** Original text, parsed quantity, unit and name, store section,
  `check_label` flag.
- **swap_choices.** Planned meal, two or three candidate recipes, status.
- **ratings.** Member, recipe, stars, rated at.
- **favourites.** Member, recipe.
- **pantry_items.** Name, optional quantity and unit, source (`manual`, `bought`, `leftover`,
  `receipt`), updated at. Phase 3 adds expiry, storage place and history.
- **staples.** Name, optional target quantity.
- **shopping_lists** and **shopping_list_items.** Name, quantity, unit, Purchase amount, store
  section, manual flag, source planned meals, structured ordering fields, `checked_at`,
  `bought_at`.

Log tables keep `owner_user_id` only. The log is personal and never moves into a Kitchen.

### Generation

- A plan run enqueues one job per day. Day jobs chain one after another so the no-repeat rule and
  pattern requests see earlier days. This keeps every job inside the module run limit of 500 AI
  calls and ten minutes.
- Job payloads carry plan and day ids only. Prompts are assembled inside the job from the database.
- Each day job splits each eater's calorie target across their Meal pattern, asks
  `ctx.ai.generateStructured` for each meal against a recipe schema, runs the Safety check, scales
  portions per eater, computes calorie fit with the existing estimator, then writes the day and
  marks it ready.
- The Safety check is deterministic first (restriction terms against parsed and original ingredient
  text) and AI-assisted second. A failing meal is regenerated up to a fixed cap. A meal still
  failing after the cap leaves its slot failed with a retry.
- The Safety check never vouches for a brand. An ingredient that names a brand or packaged
  product gets `check_label`, and the page shows a short check-the-label note.
- Locked meals, plain-text slots and unchanged days are never rewritten.
- A `solo` slot generates one meal per eater against that eater's target and restrictions only.
- Mid-week re-plan reuses the day jobs for days after today (and today's meals whose slot time has
  not passed). It runs with the Pantry mode forced to prefer on hand, reads the Pantry as it is
  now, and skips locked and already-cooked meals.
- A quick swap ("15-minute meal tonight") is a single-meal job with a cook-time cap taken from the
  request, Pantry-first ingredient choice, and a result listing any missing ingredients. It is
  reachable from Chat and from a "Quick swap" action on the meal.
- Each AI call names its task (`plan`, `swap`, `estimate`, `photo`) so per-task model bindings can
  apply once the platform supports them; until then the tier hint carries the intent.
- The page polls plan and day status, matching the existing polling pattern.
- Swap choices run as a job and the page polls for them.
- AI errors from the structured call (`needs_config`, `provider_error`, `usage_limited`,
  `validation_failed`, `aborted`) mark the day failed with a reason the UI can show. No AI error
  blocks Pantry, list, household or log tools.

### Shopping list

- The list is built by deterministic aggregation with no AI. Lines merge by normalised name and
  compatible unit. Incompatible units stay as separate lines.
- Ingredient amounts use a meal's servings override when set.
- Pantry subtraction follows the plan's Pantry mode. Purchase amounts round up using a module-owned
  table of pack sizes, falling back to the raw amount.
- Each line stores the planned meals it came from. A plan change rebuilds generated lines and
  keeps manual lines and tick state where the line still exists.
- Bought writes Pantry items with the edited amounts and stamps `bought_at`.
- Receipt text from Chat (phase 3) goes through a structured AI call that returns items and amounts, shown for
  confirmation before the Pantry changes.

### Cooking and log bridge

- Mark cooked subtracts recipe ingredients scaled to the eaters from matching Pantry items, never
  going below zero, and from phase 3 optionally saves Leftovers as Pantry items.
- Mark cooked then offers to log a portion. Accepting calls the existing log path, so the estimator
  job runs exactly as for any logged meal.
- The Rating prompt follows Mark cooked and can be skipped.

### Targets and units

- Every member, the self member included, stores its own targets on its member row. Meals never
  reads Food's nutrition preferences, because modules cannot read each other's data. Linked
  members' own targets wait for phase 5.
- Units default to US and can be switched per Kitchen. Stored quantities keep their original unit.

### Export and privacy

- The #1694 export declaration covers every table listed above plus the existing log tables.
- Logs and job payloads carry ids and counts only, never meal text, restrictions or receipt text.

## Testing Decisions

A good test drives Meals through the same entry points a user does, a module tool or the page, and
asserts on returned records and rendered state. Tests never assert on prompts, private helpers or
model prose. AI is always a scripted fake returning fixed structured results.

Three seams cover everything, agreed with Ben 2026-10-09.

1. **Module tool handlers with a fake store and a scripted fake AI.** This is the main seam. The
   existing handler, store, domain and manifest unit tests are the prior art. New tests cover the
   following.
   - Household member create, edit, delete, Meal pattern defaults, self member targets on its row.
   - Plan generation per day, chaining order, progress, cancel, failed day and retry.
   - Safety check pass, rewrite, cap reached, and every path that creates a meal (generate, swap,
     regenerate, Favourite placement).
   - No-repeat rule against last week and its override, repeats on request for patterns and meal
     prep, check-the-label notes on brand ingredients, servings override feeding the list.
   - Lock, regenerate all, one day and one meal, move, change eaters, plain-text slots,
     One-off meals, cook-time limit.
   - Calorie fit per meal and per day.
   - Shopping list merging, incompatible units, Pantry modes, Purchase amounts, sections, source
     meals, manual items, Staples, rebuild after plan change, tick, Bought into Pantry.
   - Receipt text parsing and confirmation (phase 3).
   - Mark cooked Pantry subtraction, Leftovers (phase 3), log offer through the existing estimator path,
     Rating with near-veto.
   - AI error kinds leave non-AI tools working.
   - Shared and Solo slot rules, weekday rules and per-day overrides.
   - Mid-week re-plan touches only future unlocked meals and prefers current Pantry items.
   - Quick swap from a chat request ("15-minute meal tonight") honours the time limit, prefers
     Pantry items and reports anything still to buy.
   - Rebuilt log tools: log, correct, delete, day totals.
   - Phase 3 and 4 features get tests at this seam when their phase is built.
2. **Real-database RLS and migration tests.** Two actors prove neither can read, write, export or
   delete the other's Meals rows in any new table. A migration test proves a clean install reaches the
   new schema. Phase 5 adds Kitchen-member
   visibility tests against the new platform contract.
3. **One browser test plus a live run.** The browser test follows the pattern of the existing food
   log e2e spec. It installs and enables Meals, adds a member, generates a week with the scripted
   AI, locks and swaps a meal, opens the list, ticks and marks Bought, checks the Pantry, marks a
   meal cooked, rates it and confirms the logged portion in Log, at desktop and narrow widths. The
   live run repeats the flow on a dev Moss with a real model, then repeats key steps through Chat
   ("plan next week", "what's for dinner tonight?", "add milk to the list", "I bought everything").

Every user story maps to at least one seam. The issue tracks the mapping as a checklist.

The phase 1 prototype is checked by Ben's review, not by tests.

## Out of Scope

- Grocery ordering from any store. That is its own project, using the list's structured fields.
- Product and brand matching.
- Medical or allergy guarantees beyond the Safety check against recorded restrictions.
- Any change to core packages. Gaps become blocker issues.
- Sharing before phase 5. Phases 2 to 4 store the account link only.

## Further Notes

- Melio research lives outside the repository. Melio took about three and a half minutes per day of
  plan, which is why generation is split into one job per day.
- The phase 1 prototype lives in a prototype folder beside this spec and is reviewed before phase 2
  tickets are written. It is throwaway code and is not imported by the module.
- ADR 0011 records why data is keyed by Kitchen from day one.
