# Moss builds modules on Moss

**Status:** Approved 2026-08-19 by Ben
**Date:** 2026-08-19
**Owner:** Ben
**Wayfinder map:** #1738
**Builds on:** `2026-07-08-open-module-system-user-authored-modules.md` (#818),
`2026-07-12-module-distribution-install.md`

---

## Problem Statement

An admin wants a small, personal capability that Moss does not have. Concretely: "show me the Good
Mythical Morning and Good Mythical More videos posted today, with the video embedded." Today the only
route from that sentence to a working page is for a developer to open the repo, read a fourteen-point
checklist, copy a reference module, write a manifest, write the fetch, write the page, build it, pack
it, drop it in the modules directory and restart. There is no scaffolding — no generator, no
template, no create-a-module command.

The result is that the module system, which is genuinely good, is only reachable by someone willing
to write TypeScript against an unfamiliar contract. Every personal interest that would make a good
module — a hobby, a team, a show, a feed — never becomes one, because the distance from wanting it to
having it is a development project.

Meanwhile the assistant already writes files and runs shell commands in chat, gated by approval
cards. The capability at the heart of "Moss builds you a module" is present and safe. What is missing
is the path from a scratch directory to an installed, approved, running module.

## Solution

An admin describes what they want in the chat drawer. Moss writes down what it intends to build and
the admin approves that plan. Moss then builds it — real code, in the same shape a hand-written module
has — and **the finished draft runs immediately, visible to its author and nobody else.** The admin
looks at the actual working thing and changes it by talking to Moss, seeing each change. When they
are happy, they ship it, and it becomes a real module.

The shape is **approve the plan, then judge the thing itself.**

The approval that matters is the one where the admin has an opinion. Nobody has a view on a
permissions list for a videos module; everybody has a view on the videos module once they can see it.
A review screen at the end of a build is theatre — most people will click through it to get to the
thing — so the plan is what gets approved up front, and the working draft is what gets judged.

Chat cannot hold the build itself: a chat turn is cut off at five minutes behind the reference
reverse proxy, and building a module with a page, an external fetch and tests takes longer than that.
So chat starts the work and the build runs as a background job that survives the conversation and
resumes after a restart. A first-party module — **the Workshop** — lists what is being built, what
state each build is in, and what happened.

Ben's ruling, 2026-08-19, on the earlier design where a finished module waited behind a permissions
screen: "I think I'd rather have the admin approves the plan, Moss builds it, the admin can take a
look at it and make changes with Moss directly (live edits). Then once it is finished it can be
built."

Refining is the point, not an afterthought. Nobody gets the videos module right first time; they want
bigger thumbnails, or the other channel added. Saying so in chat changes the running draft.

Version one is **admins only**. Every household member building their own module is the next phase.
That narrowing removes most of the trust problem and lets the genuinely hard parts get solved with a
user who can diagnose them.

**How much Moss stops to ask is governed by the existing "stop asking me" setting**, not by a new
preference — see Further Notes. With it off, the plan waits for approval and shipping is a button.
With it on, Moss plans, builds and ships, and tells the admin it is done.

## User Stories

**Describing and starting a build**

1. As an instance admin, I want to describe a module I want in plain language in the chat drawer, so
   that I do not have to learn a module contract to get a capability I want.
2. As an instance admin, I want Moss to ask me clarifying questions before it starts building, so
   that it does not spend ten minutes building the wrong thing.
3. As an instance admin, I want Moss to tell me plainly when what I asked for is not something a
   module can do, so that I find out in seconds rather than after a failed build.
4. As an instance admin, I want to be told roughly what a build will involve before it starts, so
   that I can decide whether it is worth it.
5. As an instance admin, I want the build to start and my chat turn to end, so that I am not staring
   at a spinner for ten minutes and losing my conversation to a timeout.
6. As an instance admin, I want to keep using chat for other things while a module builds, so that a
   build does not monopolise my assistant.

**Watching a build**

7. As an instance admin, I want a screen listing every module I am building or have built, so that a
   build is not lost when I close the conversation that started it.
8. As an instance admin, I want to see what state a build is in — thinking, writing, checking,
   waiting for me, ready, failed — so that I know whether to wait or act.
9. As an instance admin, I want to see what the build has written so far, so that I can tell it is
   doing something sensible rather than silently spinning.
10. As an instance admin, I want to be notified when a build finishes, so that I do not have to keep
    checking.
11. As an instance admin, I want a build that was interrupted by a restart to carry on rather than
    start over, so that a routine restart does not cost me ten minutes of work.
12. As an instance admin, I want to cancel a build that is going wrong, so that I am not forced to
    wait for something I no longer want.
13. As an instance admin, I want a failed build to tell me plainly what went wrong, so that I can
    decide whether to retry, rephrase, or give up.

**Approving the plan**

14. As an instance admin, I want to see what Moss intends to build before it starts — what the module
    does, what it will reach, what it will store — so that ten minutes are not spent building the
    wrong thing.
15. As an instance admin, I want to change the plan before agreeing to it, so that correcting a
    misunderstanding does not mean throwing away a build.
16. As an instance admin who has turned off being asked, I want Moss to plan, build and ship without
    stopping, so that the feature matches how I already run the rest of Moss.

**Seeing it and changing it**

17. As an instance admin, I want the finished draft to be running and visible to me the moment it is
    built, so that I judge the actual thing rather than a description of it.
18. As an instance admin, I want a draft to be visible to me alone, so that my half-finished
    experiment never appears in anyone else's sidebar.
19. As an instance admin, I want to describe a change in chat and see the running draft change, so
    that refining feels like the conversation that created it.
20. As an instance admin, I want to see the code if I choose to, so that a module is never a black
    box when I need it not to be.
21. As an instance admin, I want editing a draft not to switch it off, so that the tamper protection
    that guards finished modules does not fight me while I am building.
22. As an instance admin, I want to throw a draft away, so that an experiment that went nowhere
    leaves nothing behind.
23. As an instance admin, I want shipping a finished draft to be something I do, so that Moss never
    puts its own work in front of other people.

**Living with a module**

24. As the admin who built a module, I want it visible only to me until I decide otherwise, so that
    my experiment does not put a page in everyone else's sidebar.
25. As an instance admin, I want to enable a built module for other people once I trust it, so that
    a module that turns out to be good can be shared inside the house.
26. As a household member, I want a module someone else built to behave exactly like a built-in one,
    so that I do not have to know or care where it came from.
27. As an instance admin, I want to turn a built module off without deleting it, so that I can stop
    something misbehaving without losing the work.
28. As an instance admin, I want to delete a built module and be told plainly what happens to its
    data, so that removing it is not a guess.

**Refining**

29. As an instance admin, I want to ask for a change to a module I built in plain language, so that
    refining feels like the conversation that created it.
30. As an instance admin, I want a change request to find the right module without me naming a file,
    so that the loop is as easy as the first build.
31. As an instance admin, I want a change to be reviewed and approved the same way the first build
    was, so that "make the thumbnails bigger" cannot smuggle in a new outside service.
32. As an instance admin, I want data my module has already collected to survive a change, so that
    refining does not reset it.
33. As an instance admin, I want to see the history of what changed, so that I can tell when a
    module started misbehaving.
34. As an instance admin, I want to go back to the previous working version when a change makes
    things worse, so that refining is not a one-way door.

**Privacy and safety**

35. As a household member, I want a module someone else built to be unable to read my data, so that
    the house staying private does not depend on generated code being correct.
36. As an instance admin, I want a module whose data declaration is wrong to be refused rather than
    installed unprotected, so that the failure mode is a rejection, not a leak.
37. As an instance admin, I want a built module to be unable to reach any outside service it did not
    declare, so that its claims are enforced.
38. As an instance admin, I want a built module to be unable to give the assistant powers over its
    own setup, so that building modules is not a route to Moss expanding its own authority.
39. As an instance admin, I want everything a build did recorded, so that I can reconstruct what
    happened when something goes wrong.
40. As an instance admin, I want secrets to stay out of built modules and out of build records, so
    that a shared module cannot carry my credentials to someone else's machine.

**Sharing**

41. As an instance admin, I want to export a module I built as a folder, so that I can give it to
    someone else.
42. As an instance admin, I want the exported folder to carry no data and no credentials, so that
    sharing a module is never sharing my content.
43. As an instance admin receiving someone else's module folder, I want to install it through the
    same review and approval path as one I built, so that a gift gets the same scrutiny as a build.
44. As an instance admin receiving a module, I want to be able to change it by talking to my own
    Moss, so that I can swap their channels for mine.

**Limits**

45. As an instance admin, I want a cap on how much building can happen, so that a runaway loop
    cannot consume my AI budget overnight.
46. As an instance admin, I want to see what a build cost, so that the price of this feature is
    visible rather than a surprise on a bill.

## Implementation Decisions

**Audience and gating**

- Version one is restricted to instance admins. Non-admin building is explicitly a later phase and
  must not be designed around now beyond not painting it into a corner.
- A built module is visible to its author only until an admin enables it more widely, reusing the
  existing per-instance and per-user enablement rows rather than inventing a new visibility concept.
- A build finishing and a module going live are separate events with an explicit human approval
  between them.

**The split between chat and the workshop**

- Chat is the interface for describing and refining. It is not where the build runs.
- The build runs as a background job. This is forced: the chat turn is bounded in practice by the
  reverse proxy read timeout well before the silence watchdog matters, and a real build exceeds it.
- Background work adopts the existing self-continuation pattern used by notes indexing — do a
  bounded chunk, persist the position in the durable job row, re-queue. This is what makes a build
  restart-safe, which is a requirement, not a nicety, because restarts are routine here.
- A new first-party module owns the build list, build detail, and approval surfaces. This module is
  the answer to "does this need a module or just the chat drawer" — it needs both, because a build
  outlives the conversation that started it and chat has nowhere to put that.
- Progress reaches the user through the existing mechanisms — a status row the screen polls, and a
  notification on completion — because a worker-process job has no route into a chat transcript
  today. Building that route is not in scope.

**What a built module is**

- A built module is a real module in the existing installed-module shape: a manifest declaring its
  identity and everything it may touch, its own code, optionally its own SQL, optionally its own web
  surface. It is not a new artifact type and not an interpreted configuration.
- Full range remains the target: own database tables, scheduled work, settings, assistant tools,
  pages, declared credentials. Nothing is withheld by design. But it is delivered in stages, because
  the cost of a _draft_ running live differs enormously by capability — see "Delivery stages". Ben
  agreed 2026-08-19 that the first stage excludes a draft creating its own database tables.
- A built module must satisfy the existing module validator unchanged. The validator is the standard;
  no parallel, looser path is created for generated modules. If a generated module cannot pass it,
  that is a build failure, not a reason to relax the validator.
- The boot-time scan changes for drafts. See "A draft runs live" below. A _finished_ module still
  becomes visible at restart; lifting that for everyone is deliberately not in scope.

**Data ownership — the platform writes it, not the machine**

- A module declares, per table, that rows belong to a user. The platform generates the row-level
  protection from that declaration, extending what installation already does today.
- Generated code never authors its own privacy rules. This is the single most likely route to a real
  leak and the mitigation is to remove the opportunity.
- An automatic check backs this up: a module whose declaration and schema disagree is refused
  installation. Fail closed.
- Every user-data table keeps the existing requirements — an ownership column, protection, and a
  delete-cascade chain terminating at the users table — and the data-lifecycle declaration covering
  account export and deletion remains mandatory, with an explicitly empty list required rather than
  silence.

**A draft runs live — what that costs, from the code**

Most of what is needed already works on a running system, which makes this far cheaper than the
earlier draft of this spec assumed:

- A module's background code is already a **separate process, spawned on demand** and killed after
  sixty seconds idle (`packages/module-registry/src/external/worker-runtime.ts`, around line 233).
  Starting and stopping a module while the server runs is normal steady-state behaviour, not a new
  capability. Because it is spawned fresh from the folder each time, **edited code is picked up on the
  next run** with no restart.
- **Queue and cron registration for a single module is already live**, driven by a control-queue
  message and `packages/module-registry/src/external/job-reconciler.ts`. That is how enable and
  disable work today without a restart.
- **Pages, page files and sidebar entries are already per request.** The web asset route reads bytes
  from disk on every call with no caching (`apps/api/src/external-module-web-route.ts`), and the
  frontend re-fetches the module list and rebuilds the page route after a change.

Four things genuinely block a live draft, in size order:

1. **The discovered module list is read once at boot and frozen** (`apps/api/src/server.ts:376`,
   `apps/worker/src/worker.ts` around line 190) and handed downstream by value. A folder that appears
   later is invisible — not refused, just never looked at. The fix is mechanical: a mutable holder per
   process, a rescan trigger (an authenticated endpoint on the API, a new action on the existing
   control queue for the worker), and turning the by-value hand-offs into function calls. The job
   reconciler already takes its discoveries as a function.
2. **Per-user visibility does not exist.** A module is instance-wide on or off, with a per-user _deny_
   list only (`app.external_modules`, `app.module_enablement`). A draft visible to its author alone
   has to be invented: a draft status plus an owner on the module row, both active-module resolvers
   taught to treat a draft as active only for its owner, and `app.list_active_external_module_users`
   updated so a draft fans out to its owner alone. Without that last part the background worker would
   schedule the draft's jobs for everyone.
3. **Chat tools are fixed at boot** (`apps/api/src/server.ts:399`), so a draft cannot add tools to
   chat until the same live source replaces that snapshot. Deferrable.
4. **Database provisioning runs before the servers start**, in a separate script. Pulling role
   creation and table DDL into a running server is the expensive, genuinely risky part.

One trap: Moss fingerprints a module folder and disables it if the contents change
(`scripts/module-reconcile.ts`, the drift phase). **Drafts must be exempt**, or every edit would
switch off the thing being edited.

**Self-operation — nothing loosens**

An earlier version of this spec assumed a rule would have to give. It does not. Ben ruled 2026-08-19
that all seven categories in `packages/ai/src/gateway/self-operation.ts` stand unchanged, and the
design fits inside them:

- **Moss never ships its own work.** It builds a draft that runs for its author alone; a human presses
  ship. Installing and enabling sit under `self_authority.settings`, so this is what keeps that rule
  intact — and it is why shipping must stay a deliberate action rather than quietly becoming
  automatic.
- **Moss never handles a credential.** A module needing an API key is built able to use one and
  arrives marked as needing a key. Moss writes code that reads a key it can never itself read.
- **A module reaching an outside service is the module, not Moss**, governed by the existing module
  rules.
- **New tools reaching chat are accepted** without a cap or extra confirmation. Ben: that is the point
  of modules.
- **How much Moss stops to ask reuses the existing three-part "stop asking me" setting**, which Moss
  may never turn on for itself — see Further Notes. That is what makes a non-stopping build a human's
  standing choice rather than Moss skipping its own gate.

**Approving the plan, and shipping**

- What gets approved up front is the **plan**: what the module does, what it will reach, what it will
  store. Not code — almost nobody reads code, and a design that depends on them reading it is already
  broken.
- There is **no permissions wall in front of a finished draft.** The draft runs; the admin judges the
  running thing. What a module reaches is stated where it is useful, not as a gate people are trained
  to click past.
- The generated code is available on request, not on the main path.
- No second assistant reviews the first assistant's code. A machine vouching for a machine gives false
  confidence, which is worse than none.
- **Shipping** — promoting a draft to a real module — captures the package hash as the trusted
  baseline, reusing the existing auto-disable-on-drift behaviour. From that point the draft exemption
  in the trap above no longer applies.

**Shipping a finished module**

- Shipping is a human action. Moss may not promote its own draft, except where the admin has turned
  on the existing "stop asking me" setting, which Moss cannot turn on for itself.
- A shipped module becomes visible to other people at the next restart. The restart is performed by a
  person; the system states plainly that one is needed, what it costs — in-flight conversations end,
  the instance is unavailable for a minute or two — and the correct command for that deployment,
  reusing the existing per-deploy-mode mechanism.
- The app does not restart itself.
- The author keeps seeing their module the whole time, because it was already running as their draft.
  The restart is about everyone else.

**Refining**

- A module built this way keeps its originating conversation attached, so a change request has
  somewhere to land and the builder has the original intent as context.
- A change goes through the same build, review and approval path as the original. A refinement can
  introduce a new outside service or a new tool, so it cannot bypass review.
- Module-owned data survives a change; a refinement is an update to an existing module, not a
  replace-and-lose.
- The previous working version remains recoverable, reusing the existing behaviour that parks a
  prior version aside during an install swap.

**Sharing**

- Sharing is handing over the module folder. No catalogue, no publishing flow, no marketplace.
- The exported folder contains no user data and no credentials.
- A received folder installs through exactly the same validation, review and approval path as a
  locally built one.
- Whether the folder carries source alongside the built module is an open question, called out
  below.

**Limits**

- Building consumes AI budget and disk. Version one needs a cap on concurrent and total builds per
  instance and a visible record of what a build cost. The precise shape is open.

## Testing Decisions

A good test here asserts externally observable behaviour and never the quality or content of
generated code. Whether an AI wrote good code is not mechanically checkable; tests that try to assert
it pass while the feature is broken. Every test below fakes the AI call and exercises the machinery
around it.

**Seam 1 — a build produces something the existing validator accepts.** The highest seam in the
feature. Given a description and a faked build result, assert the produced folder passes the existing
module validator and installs. This deliberately reuses the strictest existing check rather than
inventing a parallel standard for generated modules. Prior art: the existing validator's own test
suite, which is extensive and fail-closed.

**Seam 2 — a module cannot leak one person's data to another.** Two users, one writes through a
module's table, the other reads and gets nothing. Then the case that matters more: a module whose
data declaration disagrees with its schema is refused installation rather than installed
unprotected. Prior art: the existing row-level-security tests around module installation.

**Seam 3 — a build survives a restart.** A build interrupted partway resumes from its persisted
position rather than restarting or silently dying. Restarts are routine here, so this is a normal
path, not an edge case. Prior art: the notes indexing self-continuation tests.

**Seam 4 — the assistant cannot quietly grant itself more.** Whatever loosens in the self-operation
rules, a test asserts the replacement boundary holds: a built module cannot declare its way past what
a module is permitted to be, and the build path cannot touch the categories that remain closed. Prior
art: the existing build-time assertions over the exclusion table.

**Seam 5 — a draft is visible to its author and to nobody else.** Two users, one builds a draft; the
other does not see it in their module list, cannot reach its page, and is never scheduled any of its
background work. The last part is the one most likely to be missed, because the fan-out happens in a
database function rather than in application code.

**Seam 6 — a module that appears after boot is found without a restart.** Drop a module folder in
while the server runs, trigger the rescan, and assert it becomes reachable in both the API and the
worker. Then the inverse: editing a draft's files does not disable it, while editing a shipped
module's files still does.

**Seam 7 — the screens.** The Workshop, and whatever replaces the rejected approval screen, tested at
the component level against the design system.

Explicitly not tested: whether generated code is good, and whether a built module does what the
person meant.

Modules under test: the new build/workshop module, module registry validation and installation, the
assistant gateway's self-operation boundary, and the job system's continuation behaviour.

## Interface

Mockups live in `assets/2026-08-19-moss-workshop/` (see the README there for how to view them).
Five files: three screens reviewed with Ben on 2026-08-19, two added afterwards to replace the
rejected one, and one kept only as a record.

- **The Workshop** (`workshop.html`) — the list of modules the user has asked Moss to build, grouped
  **Needs you**, **Building now**, **Live**. "The workshop" is the approved name for this surface.
- **Starting a build** (`chat.html`) — the chat drawer: the user describes what they want, confirms,
  and is told later that it is ready.
- **Agreeing the plan** (`plan.html`) — the approval moment, in the chat drawer. New.
- **Your draft, running** (`draft.html`) — the finished draft, live for its author, with the drawer
  beside it. New.
- **Review and approve** (`approval.html`) — **superseded 2026-08-19 and not to be built.** It put a
  five-section permissions wall in front of a finished module. Ben's objection stands: most people
  will click approve immediately to see the thing, so the wall trains them to click past the one
  screen that would matter on the rare occasion it does. Kept in the repo only as the record of a
  rejected direction.

**Agreeing the plan.** Moss answers the request with the plan itself, in five labelled lines — what
it does, what it reaches, what it keeps, when it runs, and roughly what it costs in time and budget.
The plan is the only raised card in the thread, because it is the only thing asking for a decision;
the surrounding conversation is plain messages. Two buttons: build it, or not yet.

There is no edit form. A plan that came out of a conversation is corrected the same way — the admin
says what is wrong and Moss reissues the whole plan with the changed line marked. Only one plan is
ever live: the superseded one is left in the thread as ordinary conversation, not as a second card
competing for a decision.

With the "stop asking me" setting on, the plan is still written but as a plain message with no
buttons, and the build starts immediately.

**The running draft.** The draft page is the module's real page, running, with nothing in front of
it. Above the page content sits one raised card — the only decision on the screen — that says the
thing is a draft only its author can see, states in one line what it reaches and what it stores, and
carries the actions: **ship it**, ask for a change, see the code, throw it away.

Ship lives there, on the thing itself, rather than in the chat drawer, for two reasons. It has to be
reachable when the drawer is closed, and shipping is a judgment about the artifact rather than a
turn in a conversation. The card also states plainly what shipping costs: the author keeps seeing
the module either way, and everyone else sees it after the next restart.

**Asking for a change** is the same chat drawer that built it, docked beside the page and scoped to
this draft — not a second, smaller chat built into the page. A change that only alters how the thing
looks is simply applied, and Moss says the page beside you is already the new one; the last change
can be put back. A change that would reach a new outside service raises a small plan card of its own
first, which is what stops "make it bigger" smuggling in a new service.

Three design rulings a build agent must not undo:

- Only the item that needs a decision is a raised card. Work in progress, live modules and the
  draft's own content are plain rows separated by a hairline.
- The Workshop sits in a ~920px column, which Ben reviewed and approved. The general standing note
  that designs often waste horizontal space is a check to run, not a licence to widen it. The draft
  screen is wider because it is two panes — a page and the drawer beside it.
- A plan is read before it is agreed, so it is never rendered in the dimmed confirmation device used
  for one-line confirmations.

Every style name in the mockups is one the design system already defines. Before changing them, run
the invented-class audit in the `design-system` skill, and note that its second grep must cover
`packages/ui/src/styles/` as well as `apps/web/src/styles/` — most primitives live in the UI package.

## Delivery stages

Each stage is usable on its own, not scaffolding for the next. The split follows the cost of running a
_draft_ live, which differs enormously by capability.

**Stage 1 — a draft with a page and background work, storing nothing new, adding nothing to chat.**
This is the videos module: fetch today's videos from two channels, show them with the video embedded.
It needs the rescan path in both processes and the draft-belongs-to-its-author concept, and nothing
else from the four blockers. Small to medium. Ben agreed 2026-08-19 to leave storage out of this
stage, accepting that early drafts are read-only.

**Stage 2 — a draft may add tools to chat.** Replaces the boot-time tool snapshot with the same live
source. Contained.

**Stage 3 — a draft may create its own tables.** Requires database role creation and table DDL from a
running server. The expensive one, with the real chance of failing quietly, and the reason the stages
are in this order. Everything already written in this spec about generated ownership rules and
fail-closed refusal applies here and must not be softened to make the stage cheaper.

Sharing, limits and cost visibility ride along with stage 1 where they are cheap and are otherwise
sequenced by the build agent's plan.

## Out of Scope

- **Finished modules going live for everyone without a restart.** Drafts are one person, one module,
  reversible, and watched by the author as it happens. The same mechanism pointed at everyone at once
  fails on people who did not ask for it. If the draft work makes this free, it is still a separate
  decision with its own proof, not a side effect.
- **Non-admins building modules.** The named next phase.
- **A browsable catalogue of built modules.** A list creates a moderation problem the instance owner
  would then own.
- **Anything marketplace-shaped** — authors, versions, ratings, trust. Already on the
  do-not-casually-build list.
- **A second assistant reviewing the first assistant's code at approval time.**
- **A route from a background job into a chat transcript.** Progress reaches the user through a
  polled status and a notification.
- **Operating-system or container sandboxing of module code.** The existing posture — starve the
  module of capability and make it ask the host — is inherited unchanged, including its known gap
  that a module's worker process retains filesystem and network capability at the OS level.

## Further Notes

**Settled by Ben on 2026-08-19.** The three load-bearing questions this spec originally left open
are now decided. A build agent implements these as written and raises anything that contradicts them
rather than reinterpreting.

**1. Where a module's source lives — its own directory, beside the modules directory, never inside
it.**

An installed module folder contains no source. Publishing strips it deliberately: what ships is the
manifest, a pre-built worker file, a pre-built web file, the SQL migrations, and a one-line marker
file (`scripts/publish-module-registry.ts:91-95`). The folder is also fingerprinted at enable time,
and if its contents change afterwards the module is disabled with "package changed since it was
enabled" (`scripts/module-reconcile.ts:41` and the drift phase at 396-412).

Two consequences follow, and both are requirements:

- Source is kept in a separate per-module directory on the install, outside the scanned modules
  directory, so that directory's contract and fingerprint are untouched. Builds happen there too.
- Refining is never an in-place edit of an installed folder. It is: change the source, rebuild,
  reinstall, go back through approval. That is also the correct behaviour on its own terms, since a
  change should be reviewed anyway.

Known limitation to state in the UI, not to solve here: a module shared as a folder carries the
built version only, so the recipient can run it but cannot ask Moss to change it.

Work in progress goes in a hidden (dot-prefixed) directory. The boot scan skips dot-prefixed names
(`packages/module-registry/src/node.ts:63`), which is the existing mechanism that keeps a half-written
module from ever being seen as live.

**2. What runs the build agent — Moss itself, on the user's own configured provider.**

No separate service and no hardcoded provider or model; the existing provider-agnostic routing
applies unchanged.

The build follows a spec-then-test-then-code shape by default, which the user may wave through:
Moss writes down what it intends to build — what the module does, what it reaches, what it stores —
then writes a failing test, then makes it pass. This is a default, not a gate: skipping it skips the
review step, never the tests.

**3. Which self-operation rules loosen — none.**

All seven categories in `packages/ai/src/gateway/self-operation.ts` stand unchanged. The feature is
built to fit inside them rather than around them:

- **Moss never installs what it built.** It writes a folder and stops. The human reads the
  plain-English claims and approves, and the install runs as that human's action. This is what keeps
  the "Moss may never grant itself authority" rule intact, and it makes the approval screen
  load-bearing rather than decorative.
- **Moss never handles the credential.** A module that needs an API key is built with the ability to
  use one and arrives marked as needing a key from the user. Moss writes code that reads a key it can
  never itself read. The build does not stop and wait for the key.
- **A module reaching an outside service is the module, not Moss**, and is governed by the existing
  module rules once approved.
- **New tools reaching chat are accepted without a cap or an extra confirmation.** Ben, 2026-08-19:
  that is the point of modules.

**The build agent may use the internet.** Ben, 2026-08-19: "I don't want to limit Moss accessing the
internet either when building. If the user says 'hey what are some good widgets out there' Moss
should be able to go search that." A build agent that cannot look anything up is a worse assistant,
and the lookup is often the point of the request.

The accompanying requirement is a record, not a restriction: **what the build fetched is captured and
shown on the review screen** alongside everything else the module claims. It blocks nothing and costs
nothing at build time, and it is what makes a misbehaving module diagnosable later.

**How much the build asks is governed by the existing instance-wide "stop asking me" setting, not by
a new preference.** That setting already has a three-part gate — the admin enables it for the
instance, the admin allows a specific person, and that person enables it for themselves — and all
three must be true (`packages/settings/src/yolo-routes.ts:22-24,187-189`).

This is the correct mechanism rather than a new one, for a load-bearing reason: Moss may never turn
that setting on for itself; it is one of the seven self-operation exclusions (the `settings.yolo.`
prefix under `self_authority.settings`). So when it is on, the build proceeding without a stop is a
human's standing configured choice, not Moss electing to skip its own gate. The self-authority rule
stays exactly as strict.

Behaviour:

- **Off (the default):** the written plan stops and waits for the user on a first build; the finished
  module waits for approval before it is installed.
- **On:** Moss plans, builds, installs and reports that it is done.

Ben's reasoning, 2026-08-19: "I don't want the user to have to approve everything... Users of Moss
will most likely have at least one power AI dork (like me) so we accept the risks." Recorded
consequence, accepted: with the setting on and the internet open, a module can go from a sentence to
running without anyone having read it. The three-part gate is what keeps that from ever being true
for someone who was not asked.

Remaining open, less load-bearing: what a module declares about its tables such that protection can be generated; how a change request finds its module; how
anyone knows a module works before it is switched on, given there is no preview; what happens when a
built module breaks at runtime and who fixes it; whether a shared module can be updated by its
author; and the exact shape of build limits.

**Stale documentation found while grounding this spec.** Two architecture decision records state that
the assistant's native file-write, file-edit and shell abilities are fully disabled via an empty
allowlist. That is no longer what the launch code does — those abilities are enabled and routed
through the approval hook instead. The module developer guide's package names have also drifted. Both
should be corrected; neither blocks this work.

**Grounding.** Every claim about current behaviour in this spec was verified against code rather than
documentation during the charting conversation on 2026-08-19. The wayfinder map, #1738, records those
findings with the files that prove them.
