# Brief: mark which Moss source files can never have an extension

Plain English rule (from Ben, applies to you): anything a human reads is written in plain English.
Name things by what they do. Keep exact names only for file paths. No colon-hinged sentences.

## What we are designing

Moss is a self-hosted assistant for a household. We are adding "extensions". For a script that
allows user customization, we ship an empty twin script. The app always calls through the twin.
If Moss (the assistant) has written its own version of a function in the twin, that version runs;
otherwise the built-in runs. The extension runs walled off. It receives the built-in function as
something it can call, plus Moss's own API acting as the person using it. It never touches the
database, files, network or credentials directly. It must take the same inputs and return the same
kind of answer as the built-in. Extensions are per person in the first version.

## Your job

Read the source files you are assigned in the read-only checkout at a read-only checkout of main at b14fb6d10 (do not edit
anything there, do not run git commands that change state). Skip tests. Give every non-test source
file one of three verdicts.

- LOCKED: must never be extensible. Use one reason code.
  - WALL: sign-in, sessions, passwords, permissions, sharing checks, privacy rules (RLS), the
    action checkpoint (risk, approval, things Moss may never do to itself), act-as grants.
  - SECRETS: storing, encrypting or using credentials for connected services or AI models.
  - EXTSYS: would be the extension system itself (loading, running, undo, off switch, re-check).
  - DATA: database schema, migrations, backup, restore, data export and deletion.
  - UPDATES: installing or updating Moss and its modules, module install and reconcile.
  - RECORD: the audit or activity record of what Moss and tools did.
  - SANDBOX: the existing wall around add-on modules and CLI agents (process isolation, the
    message protocol across it).
- OPEN: makes a choice a person could reasonably want changed. Examples are what to fetch, which
  sources, how to rank, filter, group, summarise or word something, when to nudge, how a tool is
  picked. Name the function(s) that would be the extension point and the customization in a few
  words.
- PLAIN: neither. Plumbing with no user-facing choice (types, routes that only pass data through,
  database read/write helpers, UI primitives, formatting utilities). Not locked for safety, just no
  reason to extend.

When unsure between LOCKED and anything else, choose LOCKED and say why in a few words.

## Output

Write ONE markdown file at the output path you are given. Keep it compact.

- One section per package or folder.
- Under it, a table with columns: File(s) | Verdict | Reason or extension point.
- Group consecutive files with the same verdict and reason into one row using a glob or a short
  list (for example `routes*.ts`). Every file must be covered by some row.
- End with a short "Surprises" list: anything that mixes locked and open logic in one file (these
  would need splitting before an extension point is possible), and anything you could not classify.

Bound every read: use grep and head or line ranges, read file headers and exported function names
first, open bodies only when the verdict depends on it. Your final message back to me is only the
output path and three counts (locked, open, plain). Nothing else.
