# One path for AI calls

Issue #3689. Follow-up to #3565 (PRs #3608 and #3690). Evidence in
`docs/evidence/acp-tools-off/results.md`. Status: approved by Ben, 2026-10-25.

## Problem

Moss reaches a model through at least five separate routes.

- ACP chat (`packages/acp`, `acp-chat-engine.ts`).
- Long-running Claude and Codex sessions (`claude-persistent-runtime.ts`, `codex-persistent-runtime.ts`).
- One-shot structured engines (`structured-claude-engine.ts`, `structured-gemini-engine.ts`,
  `cli-structured-adapter.ts`).
- The constrained summary runner (`constrained-structured-*`, `constrained-*-profile.ts`).
- The direct web API adapter for API-key models (`packages/ai/src/adapters/http-api.ts`).

Each route has its own launch rules, its own version checks and its own update story. The tool
update system tests only the first routes. A new Claude build reached production, passed those
checks and then failed every Meeting summary, because the constrained runner keeps a private list of
approved builds that nothing else reads. The same thing happened earlier with Codex. Each fix so
far added one more entry to that list.

## Goal

Every call to a subscription model (Claude, Codex) goes through ACP. Each call states a policy, and
the launch layer enforces it. A provider that cannot meet a policy fails with a clear message. No
route gets a private workaround.

## Findings

Both adapters can run with no tools. The evidence doc has the tables.

- **Claude:** three session options (`tools: []`, `settingSources: []`, `persistSession: false`)
  close tools, project files and saved sessions. Removing any one re-opens its own hole.
- **Codex:** a launch-time config file in a private home reduces the offered tools from 26 to 0 and
  stops project files being sent. Request level only; a real model run waits for the usage limit.
- **Policy machinery already exists.** `packages/acp` has profiles (`chat`, `workshop`,
  `unattended`), a tool table and a launch off-list. Only `chat` is built. The other profiles
  throw "not built yet".

## Decisions

1. **Add a no-tools profile to ACP.** It is the Meeting summary profile. It sets the Claude options
   and writes the Codex config above, uses a fresh private home per call and deletes it afterwards.
   No Moss tool server is attached.
2. **Callers state the profile, never the provider.** Meeting code asks for "summary, no tools".
   The router picks the provider, as it does today.
3. **The launch layer proves the policy before the call.** For Codex it reads back the tool list
   from the adapter and fails if any tool is offered. For Claude it checks the options were
   accepted. A failed check blocks the call and tells the user why.
4. **Structured answers are validated after the fact.** ACP does not force the shape. Meeting code
   asks for JSON, parses it and runs the existing evidence validation. One retry on a bad shape.
5. **The update system's live check runs the same profile.** A new Claude or Codex build must
   offer no tools under the no-tools profile and answer a structured prompt before it goes live.
   This replaces the per-build allowlist. A build that fails stays out and an admin alert fires.
6. **Retire the constrained runner after parity.** Delete `constrained-*` and the hash tables once
   the ACP profile passes the same tests. Until then both routes stay and the allowlist from #3690
   keeps production working.

## Open items

- **API-key models** use the web API adapter, which has no tool access by construction. It could
  stay as a separate transport behind the same profile call, or be wrapped. Decide at planning.
- **Gemini and OpenCode** have ACP rows but no checks yet. Out of scope; they cannot serve the
  no-tools profile until proven, and the call fails clearly.
- **Persistence on Codex.** ACP cannot pass `--ephemeral`. The per-call private home covers it, but
  the promise "nothing is saved" must be worded as "deleted after the call".

## Verification

- Live test of each provider through the profile with removal controls, as in the evidence doc,
  repeated on the real Meeting screen on a disposable instance.
- Codex real-model run after 2026-10-31.
- Unit tests for the profile launcher and the post-launch proof, each seen failing with the guard
  removed.
- Update-system live check fails a deliberately tool-offering build.

## Out of scope

Chat behaviour, the Moss tool server, provider and model settings, transcription.
