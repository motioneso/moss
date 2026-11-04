# Moss Runs Itself

**Status:** Approved by Ben on 2026-11-03
**GitHub:** issue #3973
**Owner:** Ben

## 1. Intent

The Outlook calendar sync stopped on Oct 22. Its helper container was stranded and nobody noticed
for about two weeks, including Moss. Moss runs in a container, so it cannot see or restart the
parts of itself that live on the host.

Ben's rule: "Moss is useless if it can't fix itself." Anything Ben would ask an engineer to
investigate or repair, Moss must be able to investigate and repair for any user who asks.

This is a program of four pieces, built in order. Each piece gets its own plan and its own pull
requests. This document fixes the shape of all four so the plans fit together.

## 2. Goals, non-goals, anti-goals

Goals:

- Moss finds the cause of a problem in its own jobs, logs, settings, connections, data and code.
- Moss notices a broken connection or helper and tells the user before the user finds it.
- Moss repairs known helper failures after the user approves.
- Moss proposes fixes to its own code, which a person reviews before anything changes.

Non-goals:

- No alert when Moss itself is down. If the whole app is stopped, the user deals with it.
- No free-form command access to the host for Moss.
- No self-edit of running code.
- No replacement of the feature health alerts or connector health work. Pieces 1 and 3 build on
  them.

Anti-goals (failure even if it technically works):

- Moss reads another person's private data while diagnosing.
- Moss changes anything on the host or in the code without an approval a person gave.
- Moss edits its own safety rules without a human writing or approving that change.

## 3. Decisions already made

- Privacy: private data stays private. RLS and the "private by default" rule apply to every tool in
  this program, including for admins. The diagnostic tools never return another user's private
  content.
- Admin gate: the log, job queue, source and repair tools, and starting a code change, are
  household-admin actions. A family member can see warnings about their own connections.
- Review: every code change is reviewed by a person before it takes effect.
- Ask first: Moss asks before each repair and before each code change. No unattended repairs.
- Shared accounts: self-editing code is the user's call, off by default, switched on by the admin.
  Ben: "This isn't a use it with strangers type of app. It's use it with your family."
- Standalone: Ben expects to move Moss off Docker to a standalone install in the near term. Piece 2
  is designed so that move does not rewrite it (section 6).
- GitHub is optional: proposed code changes live in the app. A pull request is also opened when
  the admin has connected GitHub. Nobody is forced onto GitHub.
- Host access is a narrow allow-listed helper on the machine, not a general shell.

## 4. Piece 1: Moss sees itself

What exists: the app map (screens, settings, error codes), about 100 chat tools over user data,
per-connection last-sync fields, news refresh attempt records, and approved designs for
self-diagnostics (#1586) and feature health alerts (#2683). The builder must check how much of
those two shipped before planning, because the code search for a self-diagnostics tool found none.

What is new: read-only tools that let Moss inspect:

- Recent application log lines, filterable by time, component and connection.
- The job queue: what ran, what failed, what is stuck, last success per job kind, and retries.
- Settings and connection state, including the last good sync and the bounded error label.
- Its own source code, matching the running version, and the running version itself.

Moss combines these to explain a cause in plain words, for example why unwanted news stories
arrive (what the job pulled in, what settings applied, which code made the choice).

Rules:

- Read-only. Fixing belongs to pieces 2 and 4.
- Admin only.
- Log and data output passes through the same redaction and privacy rules as everything else.
  Secrets never appear (existing hard invariant). Job payloads are metadata-only already.
- Output is bounded in size, so a diagnosis never floods the chat.

Open for the builder: log storage and retention (the app may not keep logs Moss can read today),
how source code is made readable inside the container, and the tool shapes.

## 5. Piece 3: warnings (approved mockups)

Ben approved mockups on 2026-11-04 in Park Press style. The approved page is
docs/superpowers/specs/mockups/moss-runs-itself/broken-connection-flow-v2.html (fonts omitted; it
loads Archivo from the app). The front-end design for the real screens still follows the
design-system skill. Three places show the
same fact:

1. Calendar screen: a left-ruled amber note ("Outlook calendar is out of date", last updated date,
   link "Ask Moss to fix it"). No boxed banner; Ben rejected it as looking like Outlook.
2. Connections: a numbered section head per connection, then one hairline-ruled row per part the
   connection depends on (browser, signed in, helper, import), each with a state. The first failing
   part is the cause. Actions: "Ask Moss to fix it" and "Show technical details".
3. Moss chat: tells the user first, lists what it checked, and offers the single repair with
   "Restart helper" and "Not now".

Every part a connection depends on needs a health check Moss can run. Today the Outlook helper has
none, which is how it went unnoticed. Warnings are driven by those checks, not by the sync result
alone. Changes to screens and settings update the app map in the same PR.

## 6. Piece 2: Moss restarts its helpers

Each connection declares a short fixed list of repairs, for example restart the Outlook browser,
restart the link between Moss and the browser, re-run the import. The list lives in code that Moss
cannot edit.

Flow:

1. Moss checks each part in order. The first failing part is the cause.
2. Moss tells the user in chat what it found and offers the one repair that fits.
3. The household admin approves. Moss runs that repair only, then re-checks and reports whether it
   worked.
4. A repair that fails once is not retried. Moss reports the failure and offers piece 4 (find the
   cause in code).
5. Every repair is logged: who approved it, what ran, the result.

Host reach: a small helper on the machine accepts only repair names from the fixed list, plus an
expected-generation check, over a private local channel. It accepts no command text, paths or
container IDs. The Moss Computer host-control path (docs/evidence/moss-computer, scripts/computer-host.ts)
is the model for this boundary. It is currently unavailable by design and is not reused as is.

Standalone: the repair list is one interface. Today the host helper implements it. After the move
off Docker, Moss runs beside its helpers and the same interface restarts them directly, so the
host helper is deleted and nothing above it changes. The plan must keep the list and approval
flow independent of the transport.

## 7. Piece 4: Moss changes its own code

Flow:

1. Piece 1 finds the cause in code. Moss says where and offers to fix it.
2. The admin approves. Moss works on a separate copy of the code, never the running one.
3. Moss makes the change, runs the tests, and files a proposed change containing a plain-English
   summary, the evidence that led to it, and the exact edits.
4. The admin reviews it in the app. If GitHub is connected, a pull request is also opened. Either
   acceptance counts.
5. An accepted change reaches the running Moss through the normal update path. Moss never edits
   itself while running.

Rules:

- Off by default. The admin switches it on in settings.
- One proposed change per problem, kept small.
- Moss never touches its safety rules: the privacy rules, the repair list and the approval gates.
  Those changes need a person to write or approve them directly.
- New screen: an in-app list of proposed changes with accept and reject. It needs mockups agreed
  with Ben before it is built (front-end design gate).

Open for the builder: how an accepted change is applied for an install with no GitHub (the update
path for a standalone install is part of the standalone project), and how tests run in the separate
copy.

## 8. Order and sizing

1. Piece 1. Independent of everything else; the others need it.
2. Pieces 2 and 3 together, sequenced alongside the standalone project.
3. Piece 4, with the in-app review screen.

Standalone is its own project and is not designed here. It only constrains piece 2 as stated above.

## 9. What the builder decides

Tool names and shapes, log retention, how the host helper authenticates the app, the health-check
format, where proposed changes are stored, and test strategy. Each piece's plan must follow
docs/DEVELOPMENT_STANDARDS.md, update the app map, and meet the live-path gate with proof through
the real UI. No piece merges as done on green tests alone.

## 10. Calls made while writing (check these)

- Admin role: the app already has an instance admin role. The plans reuse it and do not add a new
  one. Admin-only log and job tools still return no other user's private content; job and log rows
  tagged to a user are redacted to metadata for everyone else's rows.
- Approval is a button the server verifies, not a chat reply. A model-generated "yes" must never
  trigger a host action or a code change, so approval reuses the existing tool-approval prompt and
  records the approving user.
- Generation check: the helper refuses a repair if the target part has been replaced since Moss
  looked at it (a restarted or recreated container), so a stale decision cannot hit a new part.
- Helper install: a systemd user unit shipped with the repo and installed by a setup command, with
  no hand-edited settings. When no helper is present, the app shows "repair unavailable" and keeps
  the warnings. Adding it must not break prod (same PR adds it to every deployment config it needs).
- Standalone timing: pieces 2 and 3 ship on Docker with the host helper. They do not wait for the
  standalone project.
- Piece 4 needs a code checkout, Node and the test tooling on the install. Installs without them
  do not get the feature, and the settings switch explains why.
- Shipped status of #1586 and #2683: a search of the current code found an instance admin role but
  no tool or module named for feature health or log reading. The builder confirms before planning
  piece 1.
