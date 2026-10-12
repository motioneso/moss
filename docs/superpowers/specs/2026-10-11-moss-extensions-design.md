# Moss extensions: per-person customization of built-in functions

- Status: design approved in conversation by Ben, 2026-10-11. Written spec awaiting Ben's review.
- Scope: phase 0 and phase 1 in detail. Phases 2 to 6 are a roadmap only.
- Mockups: `docs/superpowers/mockups/moss-extensions/` (open `index.html`)
- File classification appendix: `docs/superpowers/specs/2026-10-11-moss-extensions/`
- Related: `2026-10-01-classifier-gate-for-chat.md`, `2026-10-05-decision-model-presets-design.md`,
  `2026-10-05-moss-acts-through-app-design.md`
- Tree read at: `b8edd4569` (classification at `b14fb6d10`)

## In plain English

Moss ships the way we like it. Each person should be able to make it their own, and Moss does the
work. A person asks in chat ("put football stories first in my news") and Moss writes a small
piece of code that replaces one built-in function for that person only. It turns on at once.

- Only functions we mark as customizable can be replaced. Everything to do with sign-in,
  permissions, privacy, secrets, data and updates is locked and can never be replaced.
- The replacement runs inside a sealed JavaScript engine. It can call the built-in function and
  read Moss's API as that person. It cannot touch files, the network, the database or any
  credential.
- If a replacement crashes, runs too long or returns the wrong kind of answer, the built-in runs
  instead. Repeated failures pause it and tell the person.
- A new Settings pane, Customizations, lists everything a person has customized. Each one can be
  reset to out of box on its own, and one button resets them all.
- Phase 1 tries this on the decision model and on news.

Phase 0 ships first and separately. The decision model turns on directly, with no trial or review
step.

## Rulings this spec carries

All from Ben, 2026-10-11.

| Topic           | Ruling                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shape           | Each customizable function has an empty twin. The system always calls through the twin, which falls back to the built-in when it holds no custom version                                         |
| Who             | Per person in phase 1. Household-wide customizations come later                                                                                                                                  |
| Privacy         | Private data stays private. A customization runs as its owner and sees only what its owner can see                                                                                               |
| Who applies     | Moss applies a customization itself. The person can undo. No draft or trial stage, because these are small tweaks; anything big is a custom module                                               |
| Outside content | Applying from a chat that holds outside content needs approval unless YOLO is on (#3417). Undo never asks                                                                                        |
| Locked          | Sign-in, permissions, privacy rules, the action checkpoint, secrets, the extension system itself, data plumbing, updates, the activity record and the add-on module wall can never be customized |
| Runner          | quickjs-emscripten with the QuickJS-ng engine, the approach Figma has used since 2019                                                                                                            |
| Persona         | Persona, behaviour and skills changes are allowed once Moss can write. They are not in phase 1                                                                                                   |
| Visibility      | The Customizations pane ships in phase 1, because it is the way back when Moss itself is broken                                                                                                  |
| Sharing         | Sharing customizations goes on the roadmap                                                                                                                                                       |
| Shadow log      | The decision model keeps its quiet log for Moss to tune from. The user trial and review step go                                                                                                  |

## Prior art

Research is kept outside the repository (competitive research rule). Its conclusions are below.

- No product offers per-person, AI-written overrides of built-in functions with automatic
  fallback. Shopify Functions is closest. We build the registry ourselves.
- Sandbox escapes happen in the glue between host and guest. Keep the glue to two functions that
  pass plain JSON.
- Pin each override to the built-in version it was written against.
- Keep all checks and the fallback in host code, out of the AI's reach. Count fallbacks and show
  them.
- Rejected runners:
  - `isolated-vm` is in maintenance mode and needs a native build
  - Hardened JavaScript (SES) cannot stop an endless loop
  - `node:vm` and Node's permission model are not walls
  - `vm2` had repeated escapes

## Phase 0: the decision model turns on directly

Ships as its own small pull request before any extension work.

- Remove the shadow-review requirement for turning the gate on.
  - `packages/settings/src/runtime-config-routes.ts`: drop the 409 that refuses `on` without a
    review record.
  - `packages/chat/src/classifier-shadow-review-repository.ts`: `resolveEffectiveGateMode` stops
    downgrading `on` when no review exists.
- Keep the shadow log and its records. Moss reads them to tune the decision model.
- Update the app map entry for the Classifier row so it no longer mentions a review step.
- Release note: the decision model can be switched on straight away.
- Live proof on dev. Switch the gate on with no review record, and see a chat request answered
  through the gate.

## Phase 1 design

### 1. How a call flows

1.1 A customization point is a built-in function marked with:

- a stable id, for example `news.rankCandidates`
- an input schema and an output schema
- a shape version, bumped by hand when either schema changes, and checked by a test that hashes
  the schemas
- a body hash, computed at build time from the built-in's source
- a time limit
- a sample input, used when the person has no recent real input
- an optional output rule (section 2.5)

1.2 Callers call the point, never the built-in directly. The point runner:

1. Looks up the person's active customization for that point in a per-process cache. The cache is
   cleared when the person applies, resets or pauses a customization.
2. If there is none, or the instance kill switch is on, it runs the built-in and returns.
3. Otherwise it runs the customization in a fresh sealed context with the input.
4. It checks the result against the output schema and the output rule.
5. If the check fails, the code throws, or the time runs out, it runs the built-in, returns that
   result, and counts one fallback.

1.3 The customization is a JavaScript module that exports one function with the same name as the
built-in. That function receives the input and two host functions.

- `builtIn(input)` runs our built-in on the host and returns its result.
- `moss.get(path, query)` reads Moss's own API as the person. Phase 1 is read-only (GET routes in
  the route catalog only), through the existing act-as path.

1.4 The engine is QuickJS-ng compiled to WebAssembly, through `quickjs-emscripten`. Every call
gets a fresh context, which takes about 0.4 ms. Limits per call:

- memory 16 MB, stack 512 KB
- the point's time limit, counted against the customization's own running time. Time spent inside
  `builtIn` or `moss.get` is not counted against it, but each of those calls keeps its own
  existing limits.
- no `eval` of host objects. No modules, timers, network, file system or clock beyond a frozen
  `Date.now()` value passed in.

1.5 Data crosses the wall as JSON text only, in both directions. The host never hands a host
object, function reference or handle into the engine. Identity is fixed on the host. The guest
never passes a user id, and any it tries to pass is ignored.

1.6 Storage is a new module, `packages/extensions`, which owns its SQL.

- `extension_versions`: one row per version (owner, point id, code, the shape version and body
  hash it was written against, a one-line name Moss writes, the chat it came from, created time)
- `extension_state`: one row per owner and point (active version or none, status, pause reason,
  last error, fallback counters)
- RLS is owner-only on both tables, with no admin bypass.
- The news compile runs in a pg-boss job. The job loads the code from the database as the person,
  and the payload carries ids only (metadata-only payload invariant).

1.7 Other modules reach the runner only through the extensions module's declared public API
(module isolation invariant). Customization points are declared in the owning module's code and
registered with the extensions module at start-up.

### 2. Safety

2.1 Points can exist only in files marked open in the classification appendix. A test fails the
build if a point is declared in a locked file. The locked list is kept as data in the extensions
module, next to the test.

2.2 Points never receive or return secrets. Where a built-in needs to know about a secret, the
point gets a yes or no instead (for example "key saved").

2.3 A customization changes what is asked and how things are chosen, ordered, grouped and worded.
It never changes a model's answer or the checks on that answer. These always run on the host
after the customization:

- the decision model's call, its confidence bars, tool eligibility, risk and approval
- the news dismissed-stories filter
- the read-time check that the person can still see each story

2.4 Three mixed files are split before any point exists, with no change in behaviour.

| File                                        | What moves out                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/chat/src/live/classifier-gate.ts` | Confidence-bar checks move out of the question step, so a point can wrap the questions only        |
| `packages/news/src/compilation/compile.ts`  | The dismissed-stories filter moves out of selection and runs after any customization               |
| `packages/news/src/compilation/rank.ts`     | Database access moves out of ranking, so the point receives candidates and never a database handle |

2.5 Output rules are host-side checks a point can declare beyond its schema.

- News filter, rank, order, group and featured points may only return stories that were in their
  input. A customization cannot add a story or change a link.
- The reply wording point returns null whenever the built-in returns null, because a missing value
  must never be papered over.
- Text outputs have a length cap per point.

2.6 Fallbacks are counted per customization. Five in one hour pause it.

- Pausing sends the person a notification through the notifications module.
- Moss reads the status and the last error through its extension tools, so it can propose a fix.
- The last error stored is the customization's own error message, capped at 500 characters, in the
  owner-only table.

2.7 The owner gets an instance-wide kill switch in its own admin pane (section 4.2). It turns
every customization off for everyone. This is configuration power only, and the owner sees no one
else's customizations.

2.8 Applying follows the existing gateway rules. If the requesting chat holds outside content,
apply asks unless YOLO is on. Undo, reset and turn all off never ask.

2.9 Self-operation. Today Moss may never shape its own prompts, persona or skills
(`packages/ai/src/gateway/self-operation.ts`). Phase 1 opens one narrow door. The decision model's
question wording and descriptions can be customized through extension points only, by the person,
with undo. Persona, memory, chat skills and page context stay excluded. They open in the phase
where customizations can write, when a person asks Moss for them.

2.10 No hard invariant changes. Customizations run as their owner under RLS, so the no-admin
private-data bypass rule stands as written.

### 3. Making, checking and undoing

3.1 Moss gets these tools, owned by the extensions module:

| Tool            | What it does                                                                  | Asks                                               |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| List points     | Lists customizable points, each with its built-in source, schemas and version | No                                                 |
| List mine       | Lists the person's customizations with status, fallbacks and last error       | No                                                 |
| Apply           | Checks and turns on new code for one point                                    | Only from a chat with outside content, unless YOLO |
| Reset           | Puts one point back to out of box                                             | No                                                 |
| Turn all off    | Puts every point back to out of box                                           | No                                                 |
| History         | Lists versions of one customization                                           | No                                                 |
| Turn on version | Makes an older version active again                                           | Same as apply                                      |

3.2 There is no draft stage. Apply runs the code once on the person's most recent real input for
that point before switching it on. The sample input is used when there is no recent input.

- The most recent input is held in process memory only, per person and point, and is lost on
  restart. It is never written to the database or a log.
- If the check crashes, times out or fails the output check, apply refuses and returns the error
  to Moss, which fixes the code and applies again.

3.3 Apply records an activity record entry with the person, the point, the chat it came from and
the code change.

3.4 Reset makes the point use the built-in again. Turn all off does that for every point. Both
keep the history, so any version can be turned on again.

3.5 After an update, the server compares each point's current shape version and body hash with
the ones each active customization was written against.

- Shape changed. The customization pauses with status "Needs updating", the built-in runs, and
  Moss can rewrite it against the new shape.
- Body changed only. The customization keeps running and is flagged so Moss can check it again.

### 4. The Customizations pane

4.1 A new pane in the person's own Settings, drawn in the mockup.

- One row per customized point, with Moss's one-line name, status (Running, Paused, Needs
  updating), fallbacks when there are some, date last changed, Reset and History.
- History shows each version with its date and the chat it came from, a way to turn one back on,
  and the code behind a collapsed control.
- Turn all off sits at the top.
- No explanatory or reassurance copy (screen copy ruling).

4.2 The owner gets a Customizations pane of their own in Admin / Setup, in the "AI & extensions"
group next to Instance modules (Ben, 2026-10-11). It holds the kill switch only. Counts of who has
customizations would need a cross-person read, which the no-admin-bypass rule forbids, so they
are left out.

4.3 The pane uses the design system and existing Settings pane structure.

4.4 App map updates in the same pull request:

- the Customizations pane and its actions in `packages/shared/src/app-map-core.ts`
- the admin Customizations pane and its kill switch
- the extensions module's features and tools in its manifest

### 5. The trial points

| Area           | Point                      | What a person can change                         | File                                                                                                                   |
| -------------- | -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Decision model | Question wording           | How the questions to the model are worded        | `packages/chat/src/live/classifier-gate.ts` (after the split)                                                          |
| Decision model | Area and tool descriptions | How each area and tool is described to the model | `packages/chat/src/live/classifier-gate-wiring.ts`, `packages/integrations/src/classifier-readable-name.ts`            |
| Decision model | Reply wording              | How the reply is worded after an action          | `packages/chat/src/live/classifier-gate-arguments.ts` (`renderReplyTemplate`)                                          |
| News           | Sources                    | Which of the person's sources feed their news    | `packages/news/src/compilation/candidates.ts` (`collectCandidates`; routing of keyed sources stays built-in)           |
| News           | Filters                    | What gets filtered out                           | `packages/news/src/compilation/filters.ts` (`applyDeterministicFilters`)                                               |
| News           | Ranking                    | How candidate stories are ranked                 | `packages/news/src/compilation/rank.ts` (`rankCandidates`, after the split)                                            |
| News           | Ordering                   | How the final list is ordered                    | `packages/news/src/compilation/rank.ts` (`orderRanked`), `packages/news/src/ranking.ts` (`rankStories`, `storyWeight`) |
| News           | Grouping                   | How stories are grouped                          | `packages/news/src/news-service.ts` (overview composition)                                                             |
| News           | Featured story             | Which story is featured at the top               | `packages/news/src/ranking.ts` (`featureEligible`)                                                                     |

Time limits are 5 ms for decision model points and 250 ms for news points.

## Tests

- Hostile customization. One test customization tries each of these, and every attempt must
  fail or fall back:
  - read a file
  - reach the network
  - read an environment variable or credential
  - read another person's data through `moss.get`
  - pass a different user id
  - loop forever
  - allocate past the memory cap
  - return a host object
  - return a story that was not in its input

  Per the security claims rule, this test must be observed failing with the wall removed (guest
  given a host function that reads files, and the output rule switched off). Record that in the
  pull request.

- Fallback. A crash, a wrong shape and a timeout each return the built-in's result and count one
  fallback. Five in an hour pause the customization and send a notification.
- Isolation. One person's customization never changes another person's news or decision model
  questions.
- Version pin. A changed shape version pauses the customization as "Needs updating". A changed
  body hash flags it and leaves it running.
- Locked files. Declaring a point in a locked file fails the build.
- Way back. Reset, turn all off and the kill switch each return the person to out of box on the
  next call.
- Apply check. Code that fails on the most recent input is refused and never becomes active.
- Speed. With no customization active, a point adds under 0.1 ms. With one active, the decision
  model points stay inside 5 ms on the sample input.

## Live proof

On the lasting test instance signed in to a real model, through the real chat:

1. Ask Moss to put football stories first in my news. The news changes and the row appears in
   Customizations.
2. Reset it. The news goes back.
3. A second account's news never changed.
4. Ask Moss to make the decision model's questions shorter. The quiet log shows the new wording.
5. Turn on the kill switch. Everything returns to out of box.

Pictures and a short recording go on the pull request.

## Roadmap

| Phase          | What ships                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0              | The decision model turns on directly and keeps its log                                                                                                                      |
| 1              | The extension engine, the Customizations pane, and the trial on the decision model and news                                                                                 |
| 2              | Looks. Per-person design tokens and style sheets, a safe mode, and a written ruling that the "design system is authored" rule governs only what we ship                     |
| 3              | Layout. Today card order moves to the server, plus building-block widgets (for example a sports widget on Today)                                                            |
| 4              | Free screen code in a sealed frame                                                                                                                                          |
| 5              | Household-wide customizations, and sharing customizations between people. Shared code arrives as outside content, so Moss reads it, explains it and asks before it turns on |
| 6              | Open the remaining open files, splitting about 25 mixed files first                                                                                                         |
| Not yet placed | Write access for customizations. Persona, behaviour and skills changes open with it                                                                                         |

## Appendix: file classification

Every non-test source file on main at `b14fb6d10` was given one verdict. Reports are in
`docs/superpowers/specs/2026-10-11-moss-extensions/`, with the brief the classifiers worked from.

| Verdict | Files | Meaning                                                                                                                                                   |
| ------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locked  | 821   | Can never be customized. Reason codes cover the safety wall, secrets, the extension system, data, updates, the activity record and the add-on module wall |
| Open    | 112   | Makes a choice a person could reasonably want changed                                                                                                     |
| Plain   | 1,104 | Plumbing with no user-facing choice                                                                                                                       |

Each report ends with the mixed files that need splitting before an open point can exist.
