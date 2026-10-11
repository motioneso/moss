import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// SCOPE NOTE (#1264 / #1121): the spec's literal exit criterion
// (docs/superpowers/specs/2026-07-26-module-self-operation-settings-commands.md, "Exit criterion
// (UAT — #1000 harness, mandatory)") is a real-chat walkthrough: ask Jarvis to change the theme,
// quiet hours, weather location, and notifications off (all four apply with NO confirmation card
// anywhere), ask it to change the persona (refused as not-a-tool), then "change that back" (undo).
// The UAT harness has no chat-capable AI provider at any seed level — confirmed by sibling specs'
// own scope notes (app-map-grounding.uat.spec.ts, runtime-context.uat.spec.ts,
// 1089-1090-chat-drawer-private.uat.spec.ts): the only seeded provider is a fake one bound solely
// to module.news, so no seed level can drive a real chat turn to a model reply, let alone a tool
// call. That gap is tracked in #1121 ("UAT harness: deterministic scriptable chat engine for
// real-LLM e2e"), reopened for this reason. This file proves the one thing that IS deterministically
// observable without a real model reply — that the assistant tool manifest never exposes a
// persona-change capability, so "change the persona" is structurally refusable as not-a-tool rather
// than a policy choice a future change could accidentally grant — and `test.fixme`s the six
// real-chat halves, citing #1121.
//
// The two "no confirmation card for a granted-tier tool" and "undo replays" halves of the exit
// criterion are proven deterministically elsewhere, without needing a real chat model:
//   - Backend, against the real gateway's own emitted event stream (not a stub): "first use after
//     install grant runs without an action card",
//     tests/integration/mcp-gateway-self-operation.test.ts. Mints a token, grants
//     `granted_at_install` the same way module install does, calls the real
//     `AssistantToolGateway.callTool`, and asserts the ONLY emitted record is `action_result` — an
//     `action_request` (the Approve/Reject card) is structurally never emitted for this path. This
//     proves the mechanism all seven round-one settings tools share (they all declare
//     `selfOperationGrant: "granted_at_install"` and go through this same dispatch); it is not
//     duplicated per-tool.
//   - Frontend, mocked e2e: "granted-tier settings tool executes with no Approve/Reject card
//     (#1264)", tests/e2e/app-shell.spec.ts (added alongside the sibling Approve/Reject tests in
//     the same describe block). Feeds the live SSE stream a real `action_result` record (the exact
//     shape the backend test above proves is the only thing emitted) with no preceding
//     `action_request`, and asserts `.action-request-card` never renders and the resolve endpoint
//     is never called — a network-level proof, not just a DOM-selector absence.
//   - Undo: tests/integration/settings-undo-apply-tool.test.ts (5 tests) and
//     tests/unit/settings-undo-stack.test.ts (7 tests), both green, prove `settings.undoLast`
//     replays via CAS (`upsertWithRevision` with the tracked write's own `resultingRevision`) and
//     refuses rather than force-writing over an intervening change.
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors runtime-context.uat.spec.ts's signIn(): `solo-admin` returns before the onboarding
// chunk, so the seeded owner still has first-run onboarding pending. Skip it only when shown.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

// Real, cookie-authed manifest listing against the running server — no chat turn or model needed.
// Proves "change the persona -> refused as not-a-tool" structurally: there is no persona-change
// tool in the manifest for a real chat turn to have ever called in the first place.
test("assistant tools never expose a persona-change capability", async ({ page }) => {
  await signIn(page);

  const body = await page.evaluate(async () => {
    const response = await fetch("/api/ai/assistant-tools");
    return response.json();
  });
  const names = JSON.stringify(body).toLowerCase();
  expect(names).not.toContain("persona");
  expect(names).not.toContain("setpersona");
});

// #1121: needs a real, instruction-following chat model to actually change the theme via a chat
// turn and observe zero confirmation cards. The mechanism (granted_at_install -> action_result
// only, never action_request) is proven for real without a model at both the backend and frontend
// layers — see the file header. Deferred until #1121's scriptable UAT chat engine exists.
test.fixme("chat changes the theme with no confirmation card and the UI reflects it (#1121)", async () => {});

// #1121: same gap as above, for quiet hours.
test.fixme("chat changes quiet hours with no confirmation card and the UI reflects it (#1121)", async () => {});

// #1121: same gap as above, for weather location.
test.fixme("chat changes the weather location with no confirmation card and the UI reflects it (#1121)", async () => {});

// #1121: same gap as above, for notifications, plus the response text must name the consequence
// in words (a silent success is a spec failure per
// docs/superpowers/specs/2026-07-26-module-self-operation-settings-commands.md's Tests section).
test.fixme("chat turns notifications off with no confirmation card and states the consequence (#1121)", async () => {});

// #1121: needs a real chat model to recognize "change that back" refers to the immediately
// preceding theme change and invoke settings.undoLast in the SAME conversation. The undo mechanism
// itself (CAS replay, refuse-on-intervening-change) is proven for real without a model — see the
// file header's undo citation.
test.fixme("chat undoes the immediately preceding change in the same conversation (#1121)", async () => {});
