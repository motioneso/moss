# #2735 Job search browser test signs real chat in on its own stack

## Problem

- `tests/uat/specs/job-search-board.uat.spec.ts` gates Phases 3-4 (the real onboarding
  conversation) on `JARVIS_UAT_REAL_CHAT_CONFIGURED`.
- That flag only means the host Codex login was copied into the stack. Nothing in this file
  installs the Codex provider, logs it in, or binds a chat model.
- Each spec file gets a fresh stack, so another file's sign-in never reaches it. The only seeded
  model is the job-search scoring model, which supports structured output only.

## Seams

- Shared helper: `tests/uat/specs/real-chat-signin.ts` `bringUpRealChatModel(page)` (#2733):
  install + log in Codex, discover the cheapest eligible chat model, bind it as the chat override,
  throw loudly if none.
- Existing callers: `real-chat-onboarding.uat.spec.ts:38`, `2032-self-diagnostics.uat.spec.ts:63`.
- Insertion point: the `if (REAL_CHAT_CONFIGURED)` block, before Phase 3
  (`job-search-board.uat.spec.ts` ~line 407). After both stack restarts in Phase 1, so the
  provider install and override survive.

## Change (test-only)

1. Import `bringUpRealChatModel` from `./real-chat-signin.js`.
2. Add a first step inside the gated block, "Real chat: sign in Codex and bind the cheapest chat
   model", calling `bringUpRealChatModel(page)`.
3. Update the header comment so it says the spec signs in its own provider.
4. No product code. No change to the ungated phases. The seed bug #2906 is out of scope.

## Verification

- Red: none practical as a unit test. The proof is the spec run itself.
- Run alone with the host Codex login present:
  `pnpm exec tsx tests/uat/run-uat.ts job-search-board.uat.spec.ts` (unpiped, output to a file,
  exit code captured). Phases 3-4 must run, not skip.
- Record the run summary and exit code on the PR.
- Pre-push: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`.
- If the helper itself fails (install, login, or no eligible model), stop and report to the
  coordinator rather than widening scope.
