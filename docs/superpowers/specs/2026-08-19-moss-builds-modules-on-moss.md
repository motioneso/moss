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

An admin describes what they want in the chat drawer. Moss builds it — real code, in the same shape a
hand-written module has — and the admin gets a working module on their own instance, which they can
refine by continuing the conversation, and hand to a friend as a folder.

The shape is **chat is the front door, a module is the workshop.**

The admin describes the module in chat. Chat cannot hold the build itself: a chat turn is cut off at
five minutes behind the reference reverse proxy, and building a module with a page, an external
fetch, settings and tests takes longer than that. So chat starts the work and the build runs as a
background job that survives the conversation. A build screen — a new first-party module — lists what
is being built, what state each build is in, what was written, and what happened. From that screen
the admin reads the module's plain-English claims, looks at the code if they want to, approves it,
and restarts to bring it live.

Refining is a loop, not a one-shot. Nobody gets the videos module right first time; they want bigger
thumbnails, or the other channel added, or it stops working when YouTube changes something. Saying so
in chat edits the module in place.

Version one is **admins only**. Every household member building their own module is the next phase.
That single narrowing removes the restart problem — an admin can restart — and most of the trust
problem, and it lets the genuinely hard parts get solved with a user who can diagnose them.

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

**Reviewing and approving**

14. As an instance admin, I want to see in plain English what a built module can reach and do —
    which outside services it calls, which tools it adds to chat, what it stores, what pages it adds
    — so that I can judge it without reading code.
15. As an instance admin, I want those claims to be the ones the system actually enforces, so that
    the summary is a guarantee rather than a description.
16. As an instance admin, I want to read the code if I choose to, so that a module is never a black
    box when I need it not to be.
17. As an instance admin, I want a module to do nothing at all until I approve it, so that a build
    finishing is never the same as a build going live.
18. As an instance admin, I want to reject a built module and say why, so that the refine loop has
    somewhere to start from.
19. As an instance admin, I want to be told clearly that a restart is needed and what it will cost —
    that everyone's in-flight conversation ends and the system is unavailable for a minute or two —
    so that I can pick a moment.

**Living with a module**

20. As the admin who built a module, I want it visible only to me until I decide otherwise, so that
    my experiment does not put a page in everyone else's sidebar.
21. As an instance admin, I want to enable a built module for other people once I trust it, so that
    a module that turns out to be good can be shared inside the house.
22. As a household member, I want a module someone else built to behave exactly like a built-in one,
    so that I do not have to know or care where it came from.
23. As an instance admin, I want to turn a built module off without deleting it, so that I can stop
    something misbehaving without losing the work.
24. As an instance admin, I want to delete a built module and be told plainly what happens to its
    data, so that removing it is not a guess.

**Refining**

25. As an instance admin, I want to ask for a change to a module I built in plain language, so that
    refining feels like the conversation that created it.
26. As an instance admin, I want a change request to find the right module without me naming a file,
    so that the loop is as easy as the first build.
27. As an instance admin, I want a change to be reviewed and approved the same way the first build
    was, so that "make the thumbnails bigger" cannot smuggle in a new outside service.
28. As an instance admin, I want data my module has already collected to survive a change, so that
    refining does not reset it.
29. As an instance admin, I want to see the history of what changed, so that I can tell when a
    module started misbehaving.
30. As an instance admin, I want to go back to the previous working version when a change makes
    things worse, so that refining is not a one-way door.

**Privacy and safety**

31. As a household member, I want a module someone else built to be unable to read my data, so that
    the house staying private does not depend on generated code being correct.
32. As an instance admin, I want a module whose data declaration is wrong to be refused rather than
    installed unprotected, so that the failure mode is a rejection, not a leak.
33. As an instance admin, I want a built module to be unable to reach any outside service it did not
    declare, so that its claims are enforced.
34. As an instance admin, I want a built module to be unable to give the assistant powers over its
    own setup, so that building modules is not a route to Moss expanding its own authority.
35. As an instance admin, I want everything a build did recorded, so that I can reconstruct what
    happened when something goes wrong.
36. As an instance admin, I want secrets to stay out of built modules and out of build records, so
    that a shared module cannot carry my credentials to someone else's machine.

**Sharing**

37. As an instance admin, I want to export a module I built as a folder, so that I can give it to
    someone else.
38. As an instance admin, I want the exported folder to carry no data and no credentials, so that
    sharing a module is never sharing my content.
39. As an instance admin receiving someone else's module folder, I want to install it through the
    same review and approval path as one I built, so that a gift gets the same scrutiny as a build.
40. As an instance admin receiving a module, I want to be able to change it by talking to my own
    Moss, so that I can swap their channels for mine.

**Limits**

41. As an instance admin, I want a cap on how much building can happen, so that a runaway loop
    cannot consume my AI budget overnight.
42. As an instance admin, I want to see what a build cost, so that the price of this feature is
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
- Full range from the start: own database tables, scheduled work, settings, assistant tools, pages,
  declared credentials. No capability is withheld from version one.
- A built module must satisfy the existing module validator unchanged. The validator is the standard;
  no parallel, looser path is created for generated modules. If a generated module cannot pass it,
  that is a build failure, not a reason to relax the validator.
- Nothing about the boot-time scan changes. A new module becomes visible when the process restarts.

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

**Self-operation — loosened deliberately, in one place**

- The seven server-owned exclusion categories currently prevent the assistant from acting on its own
  setup, including granting itself more authority. A module declares its own permissions and adds its
  own tools to chat, so an assistant that writes modules is an assistant that can write itself new
  tools. This is inside the rule as written.
- The rule is therefore changed on purpose, in one declared place, naming exactly what loosens and
  what replaces it. It must not be eroded incrementally by individual build agents.
- The replacement boundary: a built module may only declare what any module is permitted to declare;
  it is inert until a human approves it; its declarations are enforced by the platform rather than
  honoured by convention; and the build path itself may not touch the categories covering
  credentials, identity and login, consent, or the assistant's own model wiring and persona.
- This decision blocks the approval surface and the build agent's permitted powers, and should be
  settled before either is built.

**Review and approval**

- The approval surface presents the manifest's declarations as plain English, because those
  declarations are the enforced boundary and are therefore an honest summary rather than a
  description.
- The generated code is available behind a link, not on the main path.
- No second assistant reviews the first assistant's code. A machine vouching for a machine gives an
  admin false confidence, which is worse than no confidence.
- Approval captures the package hash as the trusted baseline, reusing the existing behaviour that
  auto-disables a module whose files change after it was enabled.

**Going live**

- A restart is required and is performed by a person. The system may tell the admin plainly that a
  restart is needed, what it costs, and how to do it for their deployment, reusing the existing
  mechanism that surfaces the correct restart command per deploy mode.
- The app does not restart itself in version one.
- The cost is stated honestly in the interface: in-flight conversations end, and the instance is
  unavailable for up to a few minutes.

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

**Seam 5 — the two screens.** The build progress view and the approval view, tested at the component
level against the design system. The approval view specifically must render a module's declarations
as claims, so a module declaring a new outside service cannot be approved without that appearing.

Explicitly not tested: whether generated code is good, and whether a built module does what the
person meant.

Modules under test: the new build/workshop module, module registry validation and installation, the
assistant gateway's self-operation boundary, and the job system's continuation behaviour.

## Interface

Approved mockups live in `assets/2026-08-19-moss-workshop/` (see the README there for how to view
them). Three screens, reviewed with Ben on 2026-08-19:

- **The Workshop** (`workshop.html`) — the list of modules the user has asked Moss to build, grouped
  **Needs you**, **Building now**, **Live**. "The workshop" is the approved name for this surface.
- **Review and approve** (`approval.html`) — shown before a finished module is allowed to run. It
  leads with a panel saying the module is not running yet, then five plain-English sections: what it
  reaches outside your home, what it adds to chat, what it keeps, what you will see, what it never
  gets. It ends with approve-and-restart-now, approve-and-restart-later, or send back with a note.
- **Starting a build** (`chat.html`) — the chat drawer: the user describes what they want, confirms,
  and is told later that it is ready.

Two design rulings a build agent must not undo:

- Only the item that needs a decision is a raised card. Work in progress and live modules are plain
  rows separated by a hairline.
- Working surfaces use the full width (about 1240px). The narrow reading measure is for prose only.

Every style name in the mockups is one the design system already defines. Before changing them, run
the invented-class audit in the `design-system` skill.

## Out of Scope

- **Modules appearing without a restart.** The right long-term answer, and it reverses a deliberate
  recorded decision that restarting is the only operational action there will ever be. Its own
  milestone.
- **Non-admins building modules.** The named next phase.
- **A browsable catalogue of built modules.** A list creates a moderation problem the instance owner
  would then own.
- **Anything marketplace-shaped** — authors, versions, ratings, trust. Already on the
  do-not-casually-build list.
- **A second assistant reviewing the first assistant's code at approval time.**
- **A route from a background job into a chat transcript.** Progress reaches the user through a
  polled status and a notification.
- **A preview or try-before-live environment.** None exists and building one is a separate effort.
- **Operating-system or container sandboxing of module code.** The existing posture — starve the
  module of capability and make it ask the host — is inherited unchanged, including its known gap
  that a module's worker process retains filesystem and network capability at the OS level.

## Further Notes

**Open questions a build agent must not silently resolve.** Three are load-bearing and should be
settled before the work they block:

1. **Where a module's source lives.** A module ships as finished, packed-up code today, not the code
   someone wrote. This spec requires the code be visible on request and editable in place, so source
   must live somewhere. Inside the folder means sharing carries it for free but the folder grows;
   outside means export has to gather it. Blocks: sharing, refining, the "view the code" link.
2. **What runs the build agent, and with what powers.** Whether it reuses the existing chat session
   in its per-user scratch directory or is a separate agent run; what it may read and write; and how
   its output reaches the modules directory. Blocks: the build job, and seam 4.
3. **Which self-operation rules loosen.** Covered under Implementation Decisions, unresolved in
   detail. Blocks: the approval surface and the build agent's permitted powers.

Remaining open, less load-bearing: what the build screen shows in detail; what a module declares
about its tables such that protection can be generated; how a change request finds its module; how
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
