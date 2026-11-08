# Calendar JS-54: two-tool checkpoint

Card 525. Part of #4027. Working folder: `~/Jarv1s` task worktree.

This is a partial checkpoint under the brief's context bound, **not final Calendar
acceptance**. The full Rust rewrite remains approved. The shared shell at this base
does not assemble the module host; completing execution and UI parity also exceeds
this checkpoint. Workshop and Food remain excluded.

## Delivered behavior

The Calendar package now declares two of the six original tools:

- `calendar.heartbeatWindow` reads only the actor's cached events, excludes explicit
  shares, bounds the window and result count, computes the original UTF-16 material
  revision and reports freshness and the next event boundary.
- `calendar.dayPlanDraft` accepts typed evening intent and untimed task additions to
  today's or tomorrow's saved draft. It rejects chat timing/placement fields, checks
  revisions and public task references, and retains recorded placement. It does not
  preview, apply, confirm, retry or call a provider.

The trusted Calendar wrapper reads the actor's saved locale timezone through a
declared read-only resource. The guest uses the bundled timezone catalog with
case-insensitive names and the established Los Angeles default. Exhaustive JavaScript
Intl aliases and fixed-offset names are not reconciled; full timezone parity remains
open. No job or screen is declared. App-map metadata describes only delivered behavior
and points missing adapter failures to module settings.

## Verification approach

Native tests exercise rejection before host access and heartbeat projections. The
pure-data differential runner includes heartbeat defaults, invalid inputs and Unicode
revision vectors alongside the existing Calendar data cases.

The disposable database suite installs a real signed test-registry package and invokes
the shipped Wasm tools on the shared host. It compares results and persisted drafts
against the actual production TypeScript handlers on the same actor/data. The
TypeScript draft transaction deliberately rolls back before the Rust invocation;
only newly generated block identities are normalized. The public Tasks projection
is explicitly a fixture stand-in in both implementations, not installed Tasks proof.
These calls use the installer's guest invocation, not the host's public `tools.run`
approval path. That path currently prompts for every write tool and defaults read
tools to approval. The original draft tool is approved at installation and heartbeat
is an authorized background read. Reconciling those policies is required before chat
or heartbeat integration; the current suite does not establish that parity.

Tool errors currently cross the guest ABI as message strings, so the differential
suite compares messages, not HTTP status codes. HTTP error/status parity remains open.
The existing Rust draft save also bounds positive revisions below the database integer
ceiling; production accepts larger positive integers and fails later. This rare input
difference remains open rather than being called full tool parity.

The same heartbeat shared-event exclusion assertion is observed with guest owner
predicates removed and restored. Existing five-table row-security fault witnesses
remain in the gate. These checks establish the tested fixture behavior, not full
authenticated chat or production security acceptance. Final command receipts and
review findings belong in the task proof artifact outside the source tree.

Guest and host targets remain separate. The existing manual component wrapper and
`wasm32-unknown-unknown` target remain unchanged. Although task-local wit-bindgen was
approved, it was not installed or used. No new dependency or global tool was installed;
the existing lockfile dependencies were restored offline.

## Remaining acceptance work

1. Preserve all thirteen original HTTP contracts, including existing request envelopes,
   contextual projections, defaults and error/status behavior. Existing storage routes
   are not the complete assembled route layer.
2. Port `listVisibleEvents`, `createEvent`, `deleteEvent` and `rescheduleEvent` tools.
3. Port both job kinds and their execution, retry, retention and recovery semantics.
   The shared host currently fixes retry settings; Calendar's original differences need
   a proper shared seam rather than silently adopting different behavior.
4. Port preview/approval, reserved batches, apply/idempotency, confirmation,
   follow-through, automatic mode and monitoring.
5. Supply real public Tasks, People, Briefing and connector adapters and wire the
   authenticated chat/action flow. Validate full source-run provenance before exposing
   the original create route.
6. Build screens/settings and compose the installed package into the authenticated shell.
7. Run the full parity gate and prove the real UI on a running Rust instance and an
   actual second device over HTTPS with sign-in and trusted origins.

No browser, UI, chat-gateway, provider, LAN, tailnet, HTTPS or second-device result is
claimed here. #4027 and final Calendar acceptance stay open.
