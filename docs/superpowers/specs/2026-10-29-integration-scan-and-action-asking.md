# Integration scan and action-based asking

- Issue: #3844. Phase 2 of #3842.
- Date: 2026-10-29.
- Status: draft for Ben's approval. No code in this change.
- Findings it builds on: `docs/superpowers/specs/2026-10-29-ring-latency-phase1.md`.

## Ben's rulings, 2026-10-29

1. Only deleting something or sending something externally asks permission. Home Assistant commands never ask.
2. Locking never asks. Unlocking asks or not according to a per-user setting.
3. When a user adds an integration, Moss scans it itself and builds the information the classifier models use, so nobody fills tool arguments or risk labels by hand.
4. No caps that block features. Warn instead.
5. Scope change, same day: this is not Home Assistant specific. Moss checks any integration when it is added and builds what the classifier needs to act against it. Home Assistant is the first worked example. The asking rule and the unlock-style setting apply to every integration.

## What the code does today

Verified in this worktree on 2026-10-29. File names name the owner of each fact.

- Risk is set per tool, never per action. The sorting pass in `packages/integrations/src/classifier-sorting.ts` sorts each tool into one group. The groups map to risk in the same file: Looks things up to `read`, Changes things to `write`, Sends things out to `outbound`, Sensitive to `destructive`.
- The sorting prompt in that file tells the model that Sensitive means "deletes, pays, unlocks, controls security or cannot be undone". One tool that both locks and unlocks therefore lands in Sensitive as a whole, and locking asks too.
- Code raises a tool, never lowers it, in `sortedToolRisk` in the same file. A destructive hint from the server, or a `DELETE` method on a web service tool, makes the whole tool `destructive`. The inputs to that rule are one record per tool in `packages/integrations/src/classifier-risk-inputs.ts`.
- The gateway asks from the tool's risk. `packages/ai/src/gateway/policy.ts` runs a `read` tool, always confirms a `destructive` tool, and confirms an `outbound` tool unless the integrations module marks the call as sorted safe. The mark lives in `toolRunsWithoutAsking` in `packages/integrations/src/classifier-settings.ts`: a current sort of `read` or `write` runs, `outbound` runs only with the owner's send choice, and anything unsorted, failed or stale asks.
- Every connected tool's manifest carries `risk: "outbound"` in `packages/integrations/src/tool-manifests.ts`. The current sort reaches the classifier gate as `sortedRisk` on the same manifest. The gate sets its confidence bar from that risk in `packages/chat/src/live/classifier-gate-arguments.ts` (`read` 0.90, the rest 0.95), and declines to the main model whenever the gateway would ask.
- Adding a connection lists the server's tools once and saves them. `packages/integrations/src/routes.ts` runs discovery, saves the tool list, then queues the sorting job. `packages/integrations/src/discovery.ts` returns tool names, descriptions, input schemas and hints. Nothing asks the service what devices, areas or services exist.
- Preparation drafts a description and a reply wording per tool from the tool definition alone, in `packages/integrations/src/classifier-preparation.ts`. Argument declarations come from the schema: fixed choices from an `enum`, everything else needs typed extraction. A `candidates` source is never invented there.
- Device names reach the classifier only through a hand-set mapping. `packages/integrations/src/classifier-candidates.ts` needs a named listing tool on the same connection, a setup refresh that calls it once, and a memory cache that lives for five minutes. The gate reads only that cache. A light tool whose target is a free-text name has no list to pick from, so the gate leaves the tool out.
- Sorting and preparation results sit as versioned maps on the owner's connection row, in `packages/integrations/sql/0253_integration_classifier_settings.sql` and `packages/integrations/sql/0268_integration_classifier_sort.sql`. The row is owner-only under row-level security from `packages/integrations/sql/0207_integration_connections.sql`. Deleting the connection deletes both maps.
- The only per-user asking choice stored today is send without asking, and it counts only for tools sorted as Sends things out. No lock setting and no per-action setting exists.
- Two gate blockers from phase 1 stay outside this spec: the shadow review record has no writer, and the saved gate On value is read as-is in `packages/chat/src/live/classifier-gate-mode.ts`. The scan does not fix either. Turning the gate On still needs both.

## 1. Asking is decided by the action, not the tool

### 1.1 Actions

One tool can do more than one thing. A lock tool locks and unlocks. A service-call tool can call any service the user names.

An action is one thing a tool does, picked out by the values of its deciding arguments. The deciding arguments are the ones that change what the tool does in kind: an operation name, a service name, a method, or an on/off style argument with fixed choices. An argument that only names a target or a quantity never makes a new action.

Examples:

| Tool shape                            | Actions                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lock tool with an operation argument  | Lock; Unlock                                                                                                                                               |
| Switch tool with a name argument only | Turn on and off stay one action each only where the tool itself splits them. One tool that takes a state argument has Turn on and Turn off as two actions. |
| General service-call tool             | One action per service the scan can name. A service the scan cannot name is one Unknown action.                                                            |
| Tool with no deciding argument        | One action, the tool itself                                                                                                                                |

### 1.2 What each action does

The scan sorts every action into one kind. The kind sets whether Moss asks.

| Kind                | Means                                                                                                                                                                         | Asks by default | Can the user change it                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| Looks something up  | Reads only. Changes nothing.                                                                                                                                                  | Never           | No                                                                                  |
| Changes something   | Changes state inside the service or the home. Includes turning things on or off, locking, setting a temperature, starting a scene.                                            | Never           | Yes. The user can set Ask first on one action.                                      |
| Guarded change      | A change that opens or unguards a physical place: unlocking, opening a latch, disarming an alarm, opening a garage or gate. The full list is the guarded list in section 1.4. | Asks first      | Yes. The user can set Run without asking. This is the unlock setting, generalised.  |
| Sends something out | Sends a message, post or notification to a person or an outside service.                                                                                                      | Asks first      | Yes. The user can set Run without asking. This is today's send choice, generalised. |
| Deletes something   | Deletes, removes, purges or clears a thing so it does not come back by undo in the same service.                                                                              | Always asks     | No                                                                                  |
| Unknown             | The scan could not tell what the action does.                                                                                                                                 | Always asks     | No                                                                                  |

Rules that sit over the table:

- Nothing outside Sends something out, Deletes something, Guarded change and Unknown ever asks. That is Ben's first ruling.
- Locking is a Changes something action. It never asks. That is half of Ben's second ruling.
- Unlocking is a Guarded change. It asks until the user marks that action Run without asking. That is the other half.
- A user mark is per user, per connection, per action. It never carries to a different action, a different connection, or a changed action (section 2.5).
- YOLO mode still skips asking, unchanged.
- A tainted conversation still asks where it asks today. The action kind does not weaken that rule in `packages/ai/src/gateway/policy.ts`.
- The classifier gate keeps its bars: `read` actions need 0.90 confidence, every other kind needs 0.95. The gate still declines to the main model whenever the gateway would ask.

### 1.3 How the kind is decided

In this order. The first one that settles it wins.

1. Code, from facts the service states. A `DELETE` method, a destructive hint, a read-only hint and the schema's fixed choices are facts. Code maps them with the table in section 1.5 for known services, and with plain rules for the rest: a read-only action Looks something up, a `DELETE` action Deletes something.
2. The sorting model, per action. The model reads the tool name, description, group and reduced schema as today, plus the deciding argument's fixed choices. It answers once per action, not once per tool.
3. Unknown. A skipped, invalid or missing answer leaves the action Unknown. It asks.

A model answer can never move an action out of Deletes something or Sends something out when code has placed it there. Code can raise a model's kind towards asking. Code never lowers a code-placed kind on a model's say-so. That keeps today's raise-only shape in `sortedToolRisk`.

### 1.4 The guarded list

An action is a Guarded change when it does one of these, in the service's own words or the model's:

- unlocks a lock, or opens a latch
- disarms an alarm, or arms one in a way that leaves a place unguarded
- opens a garage door, gate, or other barrier that keeps people out
- turns off a security camera's guarding, or disables an alarm

Arming an alarm, locking, and turning a camera on are Changes something. They never ask.

The list lives in one place in the integrations module, as data the sorting prompt and the code rules both read. Adding a line to it is a one-line change with a test.

### 1.5 Home Assistant, worked example

Home Assistant arrives today as a connection, not as a module with its own pages. Its tools split by device kind and operation. The scan reads the tool list the connection already discovers, then applies this table by device kind and operation. Every action Home Assistant exposes through its common device kinds is listed. A device kind or operation that is not listed is Unknown and asks until the table gains a line.

| Device kind and action                                                                             | Kind                | Asks by default |
| -------------------------------------------------------------------------------------------------- | ------------------- | --------------- |
| Any device: get state, get history, list devices, list areas, list services                        | Looks something up  | Never           |
| Light: turn on, turn off, toggle                                                                   | Changes something   | Never           |
| Switch, fan, humidifier, water heater, input helper: turn on, turn off, toggle, set level or speed | Changes something   | Never           |
| Cover (blind, shutter, curtain): open, close, stop, set position                                   | Changes something   | Never           |
| Cover that is a garage door, gate or door: open                                                    | Guarded change      | Asks first      |
| Cover that is a garage door, gate or door: close, stop, set position                               | Changes something   | Never           |
| Climate: turn on, turn off, set temperature, set mode, set fan, set humidity                       | Changes something   | Never           |
| Lock: lock                                                                                         | Changes something   | Never           |
| Lock: unlock, open (latch)                                                                         | Guarded change      | Asks first      |
| Media player: turn on, turn off, play, pause, stop, set volume, pick source                        | Changes something   | Never           |
| Scene: turn on (run the scene)                                                                     | Changes something   | Never           |
| Script: run, turn off                                                                              | Changes something   | Never           |
| Automation: turn on, turn off, trigger                                                             | Changes something   | Never           |
| Vacuum: start, pause, stop, send back to dock, clean an area                                       | Changes something   | Never           |
| Alarm panel: arm home, arm away, arm night                                                         | Changes something   | Never           |
| Alarm panel: disarm                                                                                | Guarded change      | Asks first      |
| Alarm panel: trigger the alarm                                                                     | Guarded change      | Asks first      |
| Camera: turn on, turn off                                                                          | Changes something   | Never           |
| Camera: turn off motion detection or guarding                                                      | Guarded change      | Asks first      |
| Timer, counter and schedule helpers: start, pause, finish, change                                  | Changes something   | Never           |
| Shopping list and to-do list: add an item, change an item                                          | Changes something   | Never           |
| Shopping list and to-do list: remove an item, clear the list, clear finished items                 | Deletes something   | Always asks     |
| Saved notification on the device: clear or dismiss it                                              | Deletes something   | Always asks     |
| Notify a phone or a person                                                                         | Sends something out | Asks first      |
| Send a message to an outside service (a webhook call out, a post)                                  | Sends something out | Asks first      |
| Restart or stop Home Assistant itself, reload its setup                                            | Deletes something   | Always asks     |
| Any other service call the scan cannot name                                                        | Unknown             | Always asks     |

Restart and stop sit in Deletes something because they cannot be undone from Moss and they take the whole home down. Ben can move that line at approval. No other Home Assistant action asks.

## 2. The scan

### 2.1 What the scan is

When a connection is added or changes, Moss looks at the service itself and writes down three things, with no hand filling:

1. The actions. For each tool, its actions (section 1.1), each action's kind (section 1.2), a readable name, a one-line description and a reply wording. This replaces the per-tool sort and the per-tool preparation with one per-action pass that does both jobs.
2. The targets. For each argument that names a thing in the service (a device, an area, a person, a list), the valid values: an id the tool receives and a label a person reads. For Home Assistant that is the device and area list, split by device kind.
3. The wiring. Which target list fills which argument of which action. The classifier may only offer values from the wired list for that argument.

### 2.2 When it runs

- On add. After the tool list is saved, exactly where the sorting job is queued today in `packages/integrations/src/routes.ts`.
- On change. When a refresh finds a new, removed or changed tool, and when the classifier switch turns on. A changed tool is rescanned; an unchanged one is never sent again.
- On demand. A Rescan button on the connection page queues one run. A failed action or a missing target list also offers Try again there.
- On a schedule, for targets only. Device lists drift while tool lists stay still, so a worker job refreshes every connection's target lists once a day. Actions are never rescanned on the schedule. The schedule reuses the worker-start sweep shape the sorting job already has.
- Never during a chat message. The classifier reads stored lists only, as it does today.

Each run is one background job per connection. The job payload carries the owner id, the connection id and the job kind only, as today's sort and preparation jobs do.

### 2.3 How it reads the service

- Tools and actions come from the tool list discovery already saves. The model pass sends the same reduced schema as today, plus the deciding arguments' fixed choices. The credential check runs first, unchanged: a tool whose text holds the stored credential is never sent and its actions stay Unknown.
- Targets come from calling the service's own listing tools through the gateway's no-card path, the seam `packages/integrations/src/classifier-candidates.ts` already names. A listing tool must be a Looks something up action. The scan calls each listing tool once per run and keeps only an id and a label per entry, as the candidate extraction does today.
- Wiring is worked out by Moss, not by hand. A target list wires to an argument when the model names that pairing from the tool and list descriptions, and code accepts the pairing only when the list's ids are valid values for that argument (named in its schema, or the service accepts one when the scan tests the pairing against the schema's shape). A pairing code cannot accept is not stored, and the argument keeps its schema-derived handling. For Home Assistant the pairing also has to match on device kind: a light action's target list holds lights only.
- The scan never runs a Changes something, Guarded, Sends or Deletes action. Listing calls are the only calls it makes.

### 2.4 Where it lives

- The integrations module owns the scan: the job, the model pass, the target calls, the storage and the page. No other module reads its tables. The classifier gate consumes the results only through the synthetic tool declarations the integrations module already builds in `packages/integrations/src/tool-manifests.ts`.
- Storage follows the pattern the sort and preparation maps already set. One new versioned map on the owner's connection row holds actions, keyed by tool name then action key, each with its kind, readable name, description, reply wording, argument wiring and the fingerprint of the tool definition it was made against. Target lists sit in the same map's sibling key, per listing source, with the listing tool's fingerprint and the time they were read.
- The row is already owner-only under row-level security, with no admin bypass, and the new map inherits that. Deleting the connection deletes the map. A new migration in `packages/integrations/sql/` adds the column with an empty default, following `packages/integrations/sql/0268_integration_classifier_sort.sql`.
- No secrets in the scan store. It holds no credential, no connection address, no raw listing reply and no tool result. Labels are the names the service publishes for the user's own devices.
- The five-minute memory cache for candidate lists stays as a read-through shortcut only. The stored target list is the source the gate reads, so a list survives a restart and does not start empty.

### 2.5 How the classifier uses it

- A tool joins the classifier menu per action. An action is offered when its kind is known, its description and reply wording are stored against the tool's current definition, and every required argument has a way to be filled: a fixed choice, a wired target list that is stored and current, or typed extraction when the chosen classifier supports it.
- The gate asks per action. The action's kind replaces the tool's sorted risk when the gateway decides and when the gate sets its confidence bar. The gateway learns the action from the deciding argument values in the call, checked in code before anything runs. A call whose deciding values name no stored action is Unknown and asks.
- When a device is renamed, its id stays and its label changes. The next target refresh updates the label. Nothing else moves: the wiring, the action kinds and the user's marks all key on the id, not the label. Until that refresh, the old label still shows and still works.
- When a device is removed, the next target refresh drops it from the list. The classifier stops offering it at once. A pick that still names the removed id fails the offered-values check and the gate declines to the main model, as it does today for a value that was not offered.
- When a tool changes, its fingerprint stops matching. Its actions drop out of the menu and its calls ask, until the rescan finishes. That is the stale rule the sort already uses.
- When a tool is removed, its stored actions go stale with it and are dropped on the next save. Its menu entries vanish with the tool list.
- When a user mark exists for an action whose kind or deciding values change, the mark stops counting. The action asks or runs by its new kind's default until the user marks it again. That matches today's rule that a send choice dies with the sort it was set on.

### 2.6 Size bounds warn, they do not block

Ben's fourth ruling replaces the blocking bounds on this path.

- A connection with more tools, actions or targets than the stored map holds at its bounded size still works in ordinary chat. The scan stores what fits, and the connection page shows a warning naming how many actions or targets were left out of quick requests. Nothing errors and no tool is switched off.
- A target list longer than the classifier may offer is stored in full for display. The gate offers up to its bound and the page warns that the rest need the main model. The list is never cut silently: the warning says how many were not offered, and a search argument on the action (a name the user types) still fills through typed extraction where the classifier supports it.
- One model call still covers a bounded batch of tools, as today. That bound only splits calls. It never leaves a tool out.
- The existing bounds that keep a single prompt or a single stored entry safe stay, because they guard the model call, not the feature. Where one of them leaves an action Unknown today, the page now warns in plain words instead of only marking the tool.

## 3. The per-user asking setting

### 3.1 The setting

- One mark per user, per connection, per action: Ask first, or Run without asking. No mark means the default for the action's kind (section 1.2).
- Defaults: Looks something up and Changes something run. Guarded change and Sends something out ask. Deletes something and Unknown always ask, and carry no mark.
- Setting Run without asking on a Guarded or Sends action is the generalised unlock setting. Setting Ask first on a Changes action is the reverse mark, for a user who wants a check on a change Moss would otherwise run.
- The mark is stored with the action it was set on, in the scan map on the owner's connection row. It carries the action's fingerprint. A changed action loses its mark (section 2.5). It changes only through the owner's own integrations requests, never through a job.
- Today's stored send choices convert in place: a Sends things out tool's send choice becomes a Run without asking mark on each of that tool's Sends actions (section 5).

### 3.2 Where it lives

Home Assistant has no module page and no header cog of its own, because it is a connection. The setting lives where connection tools already live: the connection's own screen under Settings, Connections, the screen `apps/web/src/settings/integration-tool-groups.tsx` already renders. Each action is a row in its kind group, and the row's menu carries the mark. Nothing new is reached from chat, and no text Settings link is added.

Ben asked for this screen as the Home Assistant module settings reached through the header cog. The code has no such module, so the mockup below draws the connection screen for a Home Assistant connection instead. It follows the same rule the design system sets for module settings: one screen, reached from the connection list, no second entry point. If Ben wants a real Home Assistant module page later, that is its own spec.

### 3.3 Mockup

Park Press, from the shared pieces in `docs/design-system.md`. The screen uses `SectionHead`, `Row`, `Switch`, `Menu`, `Badge` and the link `Button` from the shared UI library. Labels only on screen. No sentence explains the screen to the user.

```text
+------------------------------------------------------------------------------+
|  < Connections                                                               |
|                                                                              |
|  Home Assistant                                          [Connected]         |
|                                                                              |
|  01  Tools                                                   24 of 29 on     |
|  --------------------------------------------------------------------------  |
|  [Search 29 tools                    ]  ( All 29 | On 24 | Off 5 )           |
|                                                                              |
|  Changes things                                              18 of 19 on     |
|  Turn the lights on and off          HassTurnOn              [switch on] [=] |
|  Lock the front door                 HassLock                          [=]   |
|  Set the heating                     HassClimate                       [=]   |
|                                                    Show 15 more              |
|  --------------------------------------------------------------------------  |
|  Guarded                                                        2 of 2 on   |
|  Unlock the front door               HassLock      [Asks first]      [=]     |
|  Disarm the alarm                    HassAlarmDisarm [Asks first]    [=]     |
|  --------------------------------------------------------------------------  |
|  Sends things out                                               1 of 1 on    |
|  Notify a phone                      HassNotify    [Asks first]      [=]     |
|  --------------------------------------------------------------------------  |
|  Deletes things                                                 2 of 2 on    |
|  Clear the shopping list             HassShoppingList [Always asks]  [=]     |
|  --------------------------------------------------------------------------  |
|  Not scanned yet                                                     --      |
|                                                                              |
|  02  Classifier                                                              |
|  --------------------------------------------------------------------------  |
|  Use for quick requests                                          [switch]    |
|  Rescan                                          Last scanned 12 Oct, 09:14  |
|                                                    [ Rescan ]              |
+------------------------------------------------------------------------------+
```

The row menu (`[=]`) is the only place the mark is set:

```text
Unlock the front door
  Run without asking
  Ask first                         (marked)
  -------------------------------
  Keep out of the classifier
```

Screen states:

| State                                          | What shows                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Row, Guarded or Sends, no mark                 | Name, raw tool name, Asks first badge, on switch, menu                                                        |
| Row, Guarded or Sends, Run without asking mark | Asks first badge gives way to a Runs without asking badge. The menu item reads Ask first.                     |
| Row, Changes, Ask first mark                   | Runs badge gives way to Asks first. The menu item reads Run without asking.                                   |
| Row, Deletes or Unknown                        | Always asks badge. The menu holds no asking item.                                                             |
| Group header                                   | Group name, how many of its actions are on, Turn all off (Turn all on when all are off)                       |
| Scanning                                       | Tools list A to Z with a Scanning note, as the sorting pass shows today                                       |
| Scan failed for one action                     | That action sits in Not scanned yet with a Try again link button. The rest of the screen works.               |
| Target list missing                            | The Classifier section shows a warning line naming the count left out, with Rescan. Tools still work in chat. |
| Empty (no tools found)                         | One quiet line in the Tools section. No section with nothing to say renders.                                  |
| Loading                                        | The section head and a status line only. No spinner in the middle of the page.                                |

Phone width: the search box and the segmented control stack with the gaps the design system sets (8px between controls, 12px between a control and the text beside it). Nothing on the screen uses text under 11px, raw colour, or a class the shared styles do not define.

## 4. App map declarations to update

Same pull requests as the code, per the app map rule in `docs/DEVELOPMENT_STANDARDS.md`.

- `packages/integrations/src/manifest.ts`: add a feature for the scan (Moss scans a connection on add, on change, on demand and daily for targets, and builds actions, targets and wiring with no hand filling). Add a feature for action-based asking (only Deletes, Sends, Guarded and Unknown ask; a user mark per action; locking never asks). Update `integrations.connection_tools_ask_first` and `integrations.connection_classifier_candidates` so their words match the new rule. Add the scan's errors with remediations: scan failed, target list missing, no model to scan with. Each points at Rescan or at choosing a chat model.
- `packages/shared/src/app-map-core.ts`: update the Connections settings entry. It gains the per-action rows and marks, the Rescan control, the Last scanned line, and the warning for actions or targets left out of quick requests. The send-without-asking words in that entry become the per-action mark, since the group button now acts per action.
- No core screen changes. No new navigation. The classifier declarations in `packages/chat/src/manifest.ts` gain no new feature: the gate reads the same declarations, now carrying an action kind.

## 5. Migration, rollout, tests, kill gate

### 5.1 Migration notes

- One new migration in `packages/integrations/sql/`, the next free number there, adding one column to `app.integration_connections` for the scan map. The column defaults to an empty map. No existing column changes and no applied migration is edited.
- Old data converts in code, not in the migration. The conversions follow `packages/integrations/sql/0269_integration_classifier_sort_convert.sql`'s precedent of reading the old maps where they are read today:
  - A tool's current sort becomes the starting kind for its single action where a tool has one action. Tools with deciding arguments wait for their first scan; until then they ask as they do today.
  - A stored send choice becomes a Run without asking mark on that tool's Sends actions.
  - A stored preparation (description, arguments, reply wording) seeds the matching action, so a working connection does not lose its menu while the first scan runs.
- The old sort and preparation maps stay readable for one release. The scan writes only the new map. A later cleanup migration removes the old columns and is its own slice (section 6).
- Row-level security does not change. The connection row's owner-only policy already covers the new column.

### 5.2 Rollout that cannot break prod

- Land the storage and the read conversions first, with no behaviour change. Every connection asks exactly as it does today.
- Land the scan next, writing the new map in the background. The gateway and the gate do not read it yet. The connection page shows the scan's picture beside today's groups, so a wrong kind is visible before it can act.
- Turn on action-based asking per connection through the connection's classifier switch, which already exists. A connection with the switch off keeps today's tool rule in ordinary chat and gains nothing in the gate. That is the whole rollout lever: no new setting is required to ship, and no deployment config gains a required value.
- Existing connections get their first scan from the worker-start sweep, as sorting does today. Until a connection's scan lands, it behaves as today.
- Order of enabling: one test connection, then Ben's Home Assistant connection, then the rest. Each step is a switch flip, not a deploy.

### 5.3 Tests

- Unit: action splitting from deciding arguments; the kind rules in code (a `DELETE` Deletes, a read-only Looks up, a code-placed kind never lowered by the model); the guarded list against the Home Assistant table, one line per row of section 1.5; marks (default per kind, a mark lost on a fingerprint change, a Deletes action refusing a mark); size bounds warning instead of blocking.
- Integration: a scan run against the repo's test tool server stores actions, targets and wiring with no hand-set candidate source; a renamed device keeps its wiring by id; a removed device stops being offered; the gateway runs a lock and asks on the same tool's unlock; the gate declines a call whose deciding values name no stored action.
- Conversion: a stored sort, a stored send choice and a stored preparation read across into the new map, and a connection with none of them still asks everywhere it asked before.
- Live proof, per the live-path gate in `docs/DEVELOPMENT_STANDARDS.md`: on a live dev instance, add the test tool server as a connection, watch the scan land, then say the words that lock and unlock through the real chat screen and record which one asked. Home Assistant itself gets the same proof on Ben's test connection before its switch flips. Docs-only slices need no live proof.

### 5.4 Kill gate

Stop and go back to Ben before enabling action-based asking on any real connection when any of these holds:

- A Deletes, Sends or Unknown action runs without asking in any test, in the scan's own picture on the page, or in shadow records. One case stops the rollout.
- The scan wires a target list to an argument that the service then rejects, on more than a rare miss. Wrong wiring means the model pairing rule is not safe to trust, and the wiring step goes back to design.
- A connection that worked in ordinary chat stops working after its scan lands.
- The daily target refresh makes a service refuse calls (rate limit or error) on any connection.

Rolling back is one switch per connection, plus the gate mode back to shadow. The new column stays in place and harms nothing unread.

## 6. Slices

One session each. Each slice is its own pull request with its app map updates and its Release note filled in.

| Slice | Work                                                                                                                                                                              | Done when                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1     | Storage and contracts. New migration, the scan map's read and write shapes in the integrations module, conversions from the sort, send and preparation maps. No behaviour change. | Conversions pass tests. Every connection still asks as today.                             |
| 2     | The scan job. Actions, kinds, names, descriptions and reply wording per action, on add, on change and on demand. The page shows the scan's picture beside today's groups.         | A test connection shows correct actions and kinds with no hand filling.                   |
| 3     | Targets and wiring. Listing calls, stored target lists, device-kind matching, the daily target job, rename and removal handling, warn-not-block bounds.                           | The classifier offers a light by name from the scanned list. A renamed light still works. |
| 4     | Action-based asking. The gateway and the gate read the action kind and the user's marks. The send choice becomes the per-action mark.                                             | Lock runs and unlock asks on one tool, in tests and on the test connection.               |
| 5     | The setting screen. Section 3.3 built on the connection screen, with the mockup agreed with Ben first if he wants changes.                                                        | The mark can be set and cleared per action, and the page warns instead of blocking.       |
| 6     | Cleanup and Home Assistant proof. Remove the old sort and preparation reads, flip Ben's Home Assistant connection, and run the live proof.                                        | The old columns are gone, and the live proof is recorded on the pull request.             |

Out of scope: the shadow review record and the gate On check from phase 1. Both are named in What the code does today. They gate turning the classifier On, not this work, and each is its own small slice when Ben wants the gate On.
