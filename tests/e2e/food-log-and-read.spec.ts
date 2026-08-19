import { test } from "@playwright/test";

// Food Phase 1 (#926, plan §4 Task 7 "Phase 1 e2e test — required to ship") — the
// install→log→read→correct→disable→re-enable flow, THROUGH THE REAL UI on a live dev
// instance, real Chat, real AI. Per docs/DEVELOPMENT_STANDARDS.md's Live-Path Gate this is
// explicitly NOT satisfiable by a page.route()-mocked Playwright run: mocking the chat
// turn/tool-invoke responses would prove the mock, not that the assembled path (manifest →
// worker registry → estimator → store → web page) actually works end to end — which is the
// exact failure this gate exists to catch (see DEVELOPMENT_STANDARDS.md lines 54-56).
//
// This file is intentionally test.fixme()'d rather than deleted or faked with mocks:
//   - It records the exact UAT script a live run must follow, so anyone running the
//     Live-Path Gate for #926 has a checked-in, reviewed procedure instead of an ad hoc one.
//   - `external-modules/food/src/web/` (the page these steps click through) is still being
//     built by another agent in this worktree as of this writing — a mocked bundle here would
//     test a fake component, not the real one, which is worse than no test.
//   - I (the agent that wrote this file) have no live dev instance or Chat/AI access in this
//     session to actually execute and record this run — per team-lead's instructions, that
//     execution belongs to whoever runs the `verify-gate` skill / Live-Path Gate for #926, not
//     to this test-writing pass. Do not report this file as "passing" — it does not run.
test.describe("Food module — install, log, read, correct (#926 Live-Path Gate)", () => {
  test.fixme("logging a meal via Chat, reading it on the Food page, and correcting it round-trips through the real UI", async ({
    page
  }) => {
    // 1. Install: as an instance admin, Settings → Admin / Setup → Instance modules →
    //    enable "food" (mirrors external-modules.spec.ts's admin-pane flow, but against a
    //    live install, not mockExternalModules).
    // 2. Nav placement: as a normal actor, confirm "Food" appears in the primary nav
    //    adjacent to "Wellness" (plan's navigation-placement ruling, not a standalone
    //    top-level slot — see docs/superpowers/specs/926-food.md).
    // 3. Consent: open the Food page, grant AI-estimation consent via its pinned toggle
    //    (food.consent.grant) — plan requires this gate to be visible and actionable from
    //    the Food page itself, not buried in global settings.
    // 4. Log via Chat: send "I had a bowl of oatmeal with a banana for breakfast" in the
    //    real Chat surface. Assert the assistant actually invokes food.meals.log (network
    //    tab / server log shows the tool call with a real idempotencyKey — the wiring
    //    assertion's live half) and that it does not stall on the consent gate given step 3.
    // 5. Read: navigate to the Food page. Assert the logged meal's row is present with a
    //    non-null estimate, and that DevTools/network shows the row came from a
    //    food.meals.list response, not a build-time fixture (the unit suite's
    //    external-module-food-manifest.test.ts wiring-assertion test proves the manifest/
    //    registry side of this; this step proves the browser actually calls it).
    // 6. Correct via Chat: send a correction ("actually it was steel-cut oats, not
    //    instant"). Assert food.meals.correct is called with the meal's CURRENT
    //    expectedRevision (not a stale one held from step 4's response) and that the Food
    //    page's totals update to reflect the corrected estimate.
    // 7. Summarize: ask "what did I eat this week?" — assert the assistant's answer cites
    //    the corrected total, not the pre-correction one (proves food.meals.summarize reads
    //    live state, not a cached tool result).
    // 8. Disable: instance admin disables "food". Assert the nav item and every
    //    food.* assistant tool disappear for the actor (behaviour 12 — the platform's real
    //    disable path, not a test-only shortcut).
    // 9. Re-enable: assert the previously logged meal is still present and correct on the
    //    Food page (module data is retained across a disable/enable cycle, not wiped).
    //
    // Record the run per DEVELOPMENT_STANDARDS.md: `gh pr comment` linking the UAT run, its
    // exit path, and bounded DOM/network/log evidence for each numbered step above — no
    // screenshots.
  });
});
