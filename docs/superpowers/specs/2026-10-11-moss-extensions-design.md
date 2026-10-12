# Moss extensions: per-person customization of built-in functions

- Status: design approved in conversation by Ben, 2026-10-11. Revised 2026-10-12 after an outside
  review (findings M1-M7 and S1-S6, mapped in "Review changes"). Written spec awaiting Ben's
  review.
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
- The replacement runs inside a sealed JavaScript engine. It can use the built-in function's
  answer and read a small, checked part of Moss's API as that person. It cannot touch files, the
  network, the database or any credential.
- If a replacement crashes, runs too long or returns the wrong kind of answer, the built-in's
  answer is used instead. Repeated failures pause it and tell the person.
- A new Settings pane, Customizations, lists everything a person has customized. Each one can be
  reset to out of box on its own, and one button resets them all. Resetting takes effect
  everywhere at once, including news that was already put together.
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
| Runner          | A QuickJS engine compiled to WebAssembly, the approach Figma has used since 2019. We use the QuickJS-ng build through `quickjs-emscripten`                                                       |
| Persona         | Persona, behaviour and skills changes are allowed once Moss can write. They are not in phase 1                                                                                                   |
| Visibility      | The Customizations pane ships in phase 1, because it is the way back when Moss itself is broken                                                                                                  |
| Owner switch    | The owner's switch that turns customizations off for everyone gets its own admin pane in the "AI & extensions" group                                                                             |
| Sharing         | Sharing customizations goes on the roadmap                                                                                                                                                       |
| Shadow log      | The decision model keeps its quiet log for Moss to tune from. The user trial and review step go                                                                                                  |

## Prior art

Research is kept outside the repository (competitive research rule). Its conclusions are below.

- No product offers per-person, AI-written overrides of built-in functions with automatic
  fallback. Shopify Functions is closest. We build the registry ourselves.
- Figma has run plugin code in QuickJS compiled to WebAssembly since 2019. That supports the
  architecture. It does not prove our bridge safe, and Figma's exact build is not ours.
- Sandbox escapes happen in the glue between host and guest. Keep the glue small and pass plain
  JSON only.
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

- Server
  - `packages/settings/src/runtime-config-routes.ts`: drop the 409 that refuses `on` without a
    review record.
  - `packages/chat/src/classifier-shadow-review-repository.ts`: `resolveEffectiveGateMode` stops
    downgrading `on` to `off` when no review exists, for both the saved setting and the
    environment value. The review check is removed, not relaxed.
  - Update the runtime key's description so it no longer mentions a review.
- Settings screen
  - `apps/web/src/settings/settings-ai-sorting-row.tsx`: remove the review-dependent
    `canChooseOn` gate and the review-step copy. Keep the guards for "no decision model chosen"
    and "a change is already saving".
- Keep the shadow log and its records. Moss reads them to tune the decision model.
- Update the app map entry for the Classifier row so it no longer mentions a review step.
- Release note: the decision model can be switched on straight away.
- Tests
  - Through Settings, a person with no review record moves the gate from Off to On, and from
    Shadow to On.
  - With the gate On and no review record, a chat request is answered through the gate.
- Live proof on dev follows the live-path gate in `docs/DEVELOPMENT_STANDARDS.md`.

## Phase 1 design

### 1. How a call flows

1.1 A customization point is a built-in function marked with:

- a stable id, for example `news.rankStories`
- an input schema and an output schema
- a shape version, bumped by hand when either schema changes, and checked by a test that hashes
  the schemas
- a built-in fingerprint, computed at build time (section 3.6)
- a guest time budget and an elapsed-time limit (section 1.5)
- a sample input, used when the person has no recent real input
- an output rule (section 2.6)
- whether it may read Moss's API (section 2.2)

  1.2 Callers call the point, never the built-in directly. For each call the point runner:

1. Reads the person's row for that point (section 1.7) in one indexed query. This read is
   authoritative. No process caches which version is active.
2. If no version is active, the version is incompatible (section 3.6), or the instance switch is
   off, it runs the built-in and returns.
3. Otherwise it runs the active version in a fresh runtime with the input and the observed
   revision.
4. It checks the result against the output schema and the output rule.
5. If the check fails, the code throws, or a limit is hit, it returns the built-in's answer and
   records one fallback against the observed revision.

Compiled code is cached by version id. Versions never change once written, so that cache needs
no invalidation beyond eviction.

1.3 The customization is a JavaScript module that exports one `async` function with the same name
as the built-in. It receives the input and two host functions.

- `builtIn()` takes no argument and resolves to the built-in's answer for the original input. The
  host runs the built-in at most once per call and keeps the answer. A fallback reuses it, so the
  built-in's work (for example a ranking model call) never runs twice.
- `moss.get(path, query)` reads Moss's API as the person, for points that allow it, under the
  rules in section 2.2.

  1.4 The engine is the QuickJS-ng release build of `quickjs-emscripten`, using its synchronous
  WebAssembly variant (no Asyncify). The exact package and version are pinned in the plan.

- Every call creates its own runtime and context, and disposes both on every exit, together with
  every handle, result, error and pending promise. Runtimes are never shared between calls or
  people, so memory limits, interrupt handlers and pending-job queues are never shared either.
- Host calls return promises created by the host. When a host call settles, the host resolves
  the promise and runs the guest's pending jobs. The guest's final promise is read the same way.
- After a call ends, any late host result is dropped and never touches the disposed runtime.
- Upstream reports about 0.4 ms to create a context. The plan benchmarks the pinned build under
  concurrent load before any budget below is final.

  1.5 Limits per call, all enforced by the host:

| Limit            | Value                                                                         | What it bounds                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest time       | 5 ms for decision model points, 250 ms for news points                        | Time the guest's own code runs, added up across every entry into the engine                                                                  |
| Elapsed time     | 50 ms for decision model points, 2 s for news points                          | Wall-clock time from start to teardown, except while `builtIn()` is running. This catches a guest that waits on a promise nobody will settle |
| Built-in         | The built-in's own existing limit                                             | `builtIn()` runs at most once, so the hard ceiling is the built-in's limit plus the elapsed limit                                            |
| Memory           | 16 MB engine heap, 512 KB stack                                               | Guest allocation                                                                                                                             |
| Bytes in and out | Code 64 KB, input 256 KB, each API reply 256 KB, output 256 KB, 1 MB in total | Checked on the host before any text is copied into the engine                                                                                |
| API calls        | 5 per call, 2 at once                                                         | Host work done for the guest                                                                                                                 |

When any limit is hit, the host cancels outstanding host work with one cancel signal, disposes
the runtime and falls back.

1.6 Data crosses the wall as JSON text only, in both directions. The host never hands a host
object, function reference or handle into the engine. Identity is fixed on the host. Any user id,
path rewrite or extra header the guest tries to pass is ignored or refused.

1.7 Storage is a new module, `packages/extensions`, which owns its SQL.

- `extension_versions`: one row per version (owner, point id, code, the shape version and
  fingerprint it was written against, a one-line name Moss writes, the chat it came from, created
  time). Rows are never updated.
- `extension_state`: one row per owner and point (active version or none, a revision number,
  status, pause reason, last error, and fallback counters scoped to the active version).
- The instance switch is an instance setting with its own revision number.
- RLS is owner-only on both tables, with no admin bypass.
- The news compile runs in a pg-boss job. The payload carries ids only (metadata-only payload
  invariant), and the worker reads the person's row exactly as the API does.

  1.8 Every state change is one conditional update on the revision. Apply, reset, pause, turn on
  version and the instance switch each add one to the revision they change.

- Fallback counts and pauses update only if the row still has the revision the call observed. A
  failing old version can never pause its replacement.
- When apply and reset race, the first commit wins and the other is refused with the current
  state.
- A call that started before a reset may finish with the old version. Its answer is used only if
  the point's caller accepts it under its own fence. News does not (section 1.9).

  1.9 News stores what it puts together, so changing a point's version must also retire stored
  news.

- Each stored news snapshot records the extension revisions of the news points and the instance
  switch revision it was built under.
- The extensions module publishes one declared event when any of those revisions change. News
  listens and bumps its existing refresh generation for that person, which stops any compile
  that is still running from publishing its old result.
- When reading, News asks the extensions module's public API for the person's current news point
  revisions. A snapshot built under different revisions is not served. The built-in overview is
  served while a fresh compile runs.
- News never reads the extensions tables, and the extensions module never reads News tables.

  1.10 Other modules reach the runner only through the extensions module's declared public API and
  event (module isolation invariant). Points are declared in the owning module's code and
  registered with the extensions module at start-up.

### 2. Safety

2.1 Points can exist only in files on the reviewed open list, kept as data in the extensions
module.

- A test fails the build if a point is declared in any other file, including plain files and new
  files nobody has classified.
- The same test fails on a duplicate point id, or a point id whose owning module does not match
  the file's module.
- Files created by the splits in section 2.5 are added to the open or locked list explicitly.

  2.2 `moss.get` is a narrow read permission checked on every call. It is not a general way to act
  as the person.

- It goes through the same route resolver chat uses for Moss's own app actions
  (`createAppActionResolver` in `packages/chat/src/app-actions.ts`). So route policy, enabled
  modules, permissions and each module's AI consent are all checked, every call.
- It is allowed only on routes whose policy is a plain read. It refuses routes that are blocked,
  have outside effects (for example the news overview, which can start a refresh), send data out
  (`outbound`), need approval, return files or downloads, or carry secrets. The method being GET
  is never enough.
- The host builds the final path and query from a fixed template and checks them against the
  route's schema.
- In phase 1 only news points may call it. Decision model points get no API access, so nothing
  read from outside can reach the decision model's questions through a customization.
- News points return story ids and small labels, never instructions to a model, so outside text
  they read cannot reach a model prompt either.
- When there is no chat to ask, as in a background job, anything that would need approval is
  refused.

  2.3 Points never receive or return secrets. Where a built-in needs to know about a secret, the
  point gets a yes or no instead (for example "key saved").

  2.4 A customization changes what is asked and how things are chosen, ordered, grouped and worded.
  It never changes a model's answer or the checks on that answer. These stay on the host and run
  after the customization:

- the decision model's call, its confidence bars, tool ids, argument schemas, eligibility, risk
  and approval
- source eligibility, source policy, keyed-source routing, fetching, cleaning and source health
- the news dismissed-stories filter
- the read-time check that the person can still see each story

  2.5 These files are split before any point exists, with no change in behaviour.

| File                                                 | What changes                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/chat/src/live/classifier-gate.ts`          | Confidence-bar checks move out of the question step, so a point can wrap the question wording only                                     |
| `packages/news/src/compilation/compile.ts`           | The dismissed-stories filter moves out of selection and runs after any customization                                                   |
| `packages/news/src/compilation/rank.ts`              | Database access moves out of ranking, so the point receives candidates and never a database handle                                     |
| `packages/news/src/compilation/candidates.ts`        | Choosing which of the person's approved sources and topics to use becomes its own pure function. Collection stays on the host          |
| `packages/news/src/news-service.ts`                  | Grouping becomes one function used by both the stored-snapshot path and the live overview path                                         |
| `packages/news/src/ranking.ts` and the news web page | The featured story is chosen on the server and sent with the overview. The page uses it, and keeps its own rule only when none is sent |

2.6 Output rules are host-side checks each point declares beyond its schema.

- News points return story ids, never stories. The host rebuilds each story from its own copy of
  the input, so a customization cannot invent a story or change a link, title or domain.
- The source point returns ids from the approved set it was given.
- The ranking point returns the ids it was given, in a new order, each with an optional score.
- The grouping point returns groups of the given ids, each with a plain-text label of at most 60
  characters.
- The featured point returns one id that passes the built-in eligibility rule, or none.
- The reply wording point returns null whenever the built-in returns null, because a missing
  value must never be papered over.
- Question and description text has a length cap per point.

  2.7 Fallbacks are counted per version. Five in one hour pause it.

- Pausing sends the person a notification through the notifications module.
- Moss reads the status and the last error through its extension tools, so it can propose a fix.
- The last error stored is the customization's own error message, capped at 500 characters, in
  the owner-only table.

  2.8 The owner gets a switch that turns every customization off for everyone, in its own admin
  pane (section 4.2). This is configuration power only, and the owner sees no one else's
  customizations.

  2.9 Applying follows the existing gateway rules. If the requesting chat holds outside content,
  apply asks unless YOLO is on. Undo, reset and turn all off never ask.

  2.10 Self-operation. Today Moss may never shape its own prompts, persona or skills
  (`packages/ai/src/gateway/self-operation.ts`). Phase 1 opens one narrow door. The decision model's
  question wording and descriptions can be customized through extension points only, by the person,
  with undo. Persona, memory, chat skills and page context stay excluded. They open in the phase
  where customizations can write, when a person asks Moss for them.

  2.11 No hard invariant changes. Customizations run as their owner under RLS, so the no-admin
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

- The check runs under the same limits as a real call, and `builtIn()` there uses the recorded
  answer when one is held, so a check never repeats paid work.
- The most recent input and built-in answer are held in process memory only, one per person and
  point, for at most 24 hours. They are never written to the database or a log.
- If the check fails, apply refuses and returns the error to Moss, which fixes the code and
  applies again.

  3.3 Apply records an activity record entry with the person, the point, the chat it came from and
  the code change.

  3.4 Reset makes the point use the built-in again. Turn all off does that for every point. Both
  keep the history, so any version can be turned on again.

  3.5 The person's stored versions are kept to the newest 20 per point. Older ones are deleted.

  3.6 Compatibility is checked on apply, on turn on version, and on every call.

- The shape version must match the point's current one. If not, the version is treated as
  "Needs updating", the built-in runs, and Moss can rewrite it against the new shape. This holds
  for older versions turned on from History too.
- A point that no longer exists marks its versions "Needs updating" and they never run.
- The fingerprint covers the built-in's file and every file in the same package it imports,
  directly or indirectly, hashed at build time. Code in other packages is not covered, and the
  screen does not claim it is. If the fingerprint changes and the shape does not, the
  customization keeps running and is flagged so Moss can check it again.

  3.7 Data lifecycle is declared in the module manifest.

- Both tables are owned tables, deleted with the person's account.
- Account export includes the person's versions and state, code included.
- The in-memory recent inputs and compiled code for a person are evicted when the account is
  deleted.

### 4. Screens

4.1 A new Customizations pane in the person's own Settings, drawn in the mockup.

- One row per customized point, with Moss's one-line name, status (Running, Paused, Needs
  updating), fallbacks when there are some, date last changed, Reset and History.
- History shows each version with its date and the chat it came from, a way to turn one back on,
  and the code behind a collapsed control.
- Turn all off sits at the top.
- No explanatory or reassurance copy (screen copy ruling).
- The pane does not depend on chat or on any customization working, because it is the way back.

  4.2 The owner gets a Customizations pane in Admin / Setup, in the "AI & extensions" group next to
  Instance modules (Ben, 2026-10-11). It holds the switch only. Counts of who has customizations
  would need a cross-person read, which the no-admin-bypass rule forbids, so they are left out.

  4.3 Both panes use the design system and the existing Settings pane structure.

  4.4 App map updates in the same pull request:

- the Customizations pane and its actions in `packages/shared/src/app-map-core.ts`
- the admin Customizations pane and its switch
- the extensions module's features and tools in its manifest

### 5. The trial points

| Area           | Point                      | What a person can change                                   | Where                                                                                                       |
| -------------- | -------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Decision model | Question wording           | How the questions to the model are worded                  | `packages/chat/src/live/classifier-gate.ts` (after the split)                                               |
| Decision model | Area and tool descriptions | How each area and tool is described to the model           | `packages/chat/src/live/classifier-gate-wiring.ts`, `packages/integrations/src/classifier-readable-name.ts` |
| Decision model | Reply wording              | How the reply is worded after an action                    | `packages/chat/src/live/classifier-gate-arguments.ts` (`renderReplyTemplate`)                               |
| News           | Sources                    | Which of the person's approved sources and topics are used | The new source-choice function split out of `packages/news/src/compilation/candidates.ts`                   |
| News           | Filters                    | Which stories are left out                                 | `packages/news/src/compilation/filters.ts` (`applyDeterministicFilters`)                                    |
| News           | Ranking                    | How stories are ranked and ordered                         | `packages/news/src/compilation/rank.ts` (after the split), `packages/news/src/ranking.ts` (`rankStories`)   |
| News           | Grouping                   | How stories are grouped                                    | The grouping function split out of `packages/news/src/news-service.ts`                                      |
| News           | Featured story             | Which story is featured at the top                         | The server-side featured choice split out of `packages/news/src/ranking.ts`                                 |

The earlier draft had separate ranking and ordering points. They are one point now, because both
return the same thing, an order over the ids given.

## Tests

Every security property below gets its own hostile case and its own control. The control removes
only that one guard and must turn the case red. The pull request records each pair, red and green,
per the security claims rule.

- The wall
  - reading a file, reaching the network, reading an environment variable
  - returning a host object, or passing a user id, path or header to `moss.get`
  - passing more than the byte limits
- Limits
  - an endless loop, allocation past the memory cap
  - a promise that never settles, top-level await, and a timeout after `builtIn()` returns
  - more than five API calls, more than two at once, and API calls left running when the guest
    throws
  - calling `builtIn()` several times, then throwing. The built-in runs once in total, fallback
    included
  - a late host result after teardown
- `moss.get`
  - the blocked news overview route is refused
  - a wellness read with its AI consent switched off is refused
  - an outbound route (for example weather place search) is refused
  - a route needing approval is refused in a background job
  - a decision model point calling it is refused
  - another person's data cannot be read
- Output rules
  - a news point returning an id it was not given, or trying to change a story's link or title
  - a grouping label past 60 characters
  - a featured id that fails the eligibility rule
  - a reply wording that fills in a missing value
- Revisions
  - with the API process and the worker both warm, reset takes effect on the next call in both
  - a failing old version cannot pause its replacement
  - apply racing reset leaves one defined winner
  - an older version with an old shape, turned on from History, shows "Needs updating" and never
    runs
- News recovery
  - a stored snapshot built with a customization is not served after reset, pause or the
    instance switch
  - a compile that started before reset does not publish its result
  - the built-in overview is served while the fresh compile runs
- Isolation
  - two people with different customizations, called at the same time, each get their own result
- Way back
  - reset, history and turn all off work from Settings while chat is broken
- Build
  - a point declared in a plain, locked or unclassified file fails the build, as does a
    duplicate id
- Speed
  - with no customization active, a point adds one indexed read and nothing else
  - budgets are confirmed by benchmark under concurrent load before the plan fixes them

## Live proof

Follows the live-path gate in `docs/DEVELOPMENT_STANDARDS.md`. That means an executable run
through the real screens on a live dev instance, with its exit code and bounded text assertions
recorded on the pull request, and no screenshots. It runs on the lasting test instance signed in
to a real model.

1. Ask Moss in chat to put football stories first. The news page lists a football story first,
   and the Customizations pane shows the row.
2. Reset it from Settings. The news page returns to the built-in order on the next load, without
   waiting for a refresh.
3. A second account's news order never changed.
4. Ask Moss to make the decision model's questions shorter. The quiet log records the new
   wording.
5. Turn off customizations from the owner's pane. Both people are back to out of box on their
   next request.

## Review changes

The 2026-10-12 outside review found these gaps. Each is closed by the section named.

| Finding                                                            | Closed by         |
| ------------------------------------------------------------------ | ----------------- |
| M1 the API bridge skipped route policy, consent and outbound       | 2.2               |
| M2 a never-settling promise had no deadline                        | 1.4, 1.5          |
| M3 no total bound on host work; fallback re-ran the built-in       | 1.3, 1.5, 3.2     |
| M4 per-process caches and blind failure counts                     | 1.2, 1.7, 1.8     |
| M5 reset left stored news customized                               | 1.9               |
| M6 the sources point could invent stories and skip policy          | 2.4, 2.5, 2.6, 5  |
| M7 phase 0 missed the Settings screen gate                         | Phase 0           |
| S1 runtime sharing and byte limits                                 | 1.4, 1.5          |
| S2 featured story was decided in the browser                       | 2.5, 2.6, 5       |
| S3 History could bypass the version check                          | 3.6               |
| S4 no data lifecycle                                               | 3.5, 3.7          |
| S5 build check rejected locked files instead of allowing open ones | 2.1               |
| S6 tests and live proof did not cover each guard                   | Tests, Live proof |

## Roadmap

| Phase          | What ships                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0              | The decision model turns on directly and keeps its log                                                                                                                      |
| 1              | The extension engine, the Customizations panes, and the trial on the decision model and news                                                                                |
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

Each report ends with the mixed files that need splitting before an open point can exist. The
open list used by the build check (section 2.1) starts from the open rows here and changes only by
review.
