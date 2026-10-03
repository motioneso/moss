# Lane plan: classifier gate 2b.6, real integrations-screen proof (#2936)

Section 2b.6 of `2026-10-01-classifier-gate-for-chat.md` is the contract. This lane adds no
product behavior. It adds the browser test and the fake tool server the test needs, and fixes
any narrow product bug the test exposes.

## Pieces

1. Fake tool server (`tests/uat/fixtures/`): a real MCP server over streamable HTTP with a
   name-valued light switch, a read-only device listing, a sensitive unlock action, tools with
   missing and false risk hints, and a tool list and schema the test can change at runtime. It
   keeps a call log so the test can prove what ran. Control endpoints are on the same port and
   the test reaches them through the stack's own container, because the host cannot route to
   the stack network.
2. Stack wiring: an opt-in switch in the browser-test provisioner, same shape as the briefing
   writer fixture (own container on the stack network, removed before teardown, address handed
   to the spec through an environment variable).
3. The spec `tests/uat/specs/classifier-integrations.uat.spec.ts`, real model through the
   Codex sign-in on the cheapest tier. It stops loudly if no model is reachable.

## Assertions (all through the real screen and the real API behind it)

- Connect through the integrations screen. Starting state: switch off, every tool off.
- Discover and curate tools. Turn on preparation, read the disclosure, run preparation.
- Edit one draft, approve it, choose a risk. Opt in only the selected tools.
- A tool with no confirmed risk stays out, whatever hint the server gives.
- Model calls for setup are counted from the model activity log: exactly one batch per
  definition version. Reconnecting with unchanged configuration adds none.
- Change the tool list or a schema on the server: the preparation shows as changed, the
  classifier pauses on that connection, new tools stay off, re-preparing adds one batch.
- Second user cannot see or use the first user's preparation or connection.
- Menu resolver assertions: only opted-in, reviewed tools appear; unknown-risk excluded; device
  names come from the read-only listing; stale preparation yields nothing.
- Ordinary chat approval is unchanged in normal and YOLO mode (existing gateway rules).
- Shadow is not merged. These are assertions on stored setup and the menu resolver, not
  end-to-end shadow.

## Order

1. Fixture server, its unit test, provisioner switch.
2. Spec skeleton that connects and discovers; run it on an isolated stack.
3. Add the remaining assertions one at a time.
4. Full gate, browser run with exit code, push, PR, proof comment.

Departs from the plan section: no. Isolated stack only, never prod or the shared dev database.
