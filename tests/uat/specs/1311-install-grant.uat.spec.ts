import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// SCOPE NOTE (#1311, see docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md
// Task 4 and docs/superpowers/handoffs/2026-07-27-1311-install-grant-relay-9.md "Order for the
// successor"): the plan's literal Task 4 asks for a live dispatch of a `granted_at_install` tool
// on a `defaultEnabled` module with no prior explicit enable action, confirming zero confirm card.
// The UAT harness has no chat-capable AI provider at any seed level — confirmed by sibling specs'
// own scope notes (1264-settings-self-operation.uat.spec.ts, runtime-context.uat.spec.ts,
// app-map-grounding.uat.spec.ts): the only seeded provider is a fake one bound solely to
// module.news, so no seed level can drive a real chat turn to a tool call. That gap is tracked in
// #1121.
//
// tasks is a required, always-enabled module — it never traverses an explicit enable PATCH, so
// (per the plan's own Path B rationale) its `task_changes` family (all members declared
// `granted_at_install`, packages/tasks/src/manifest.ts:641-769) can ONLY ever pick up its
// install-time trust grant via read-time self-heal, never an install/enable action. This makes it
// the one `granted_at_install` family this harness CAN prove for real without a chat model: the
// self-heal fires on a plain, cookie-authed GET, no tool dispatch required.
//
// This file proves the self-heal-on-read half deterministically: `solo-admin` never runs the
// tasks seed chunk (tests/uat/seed/levels.ts — seedDataChunks only runs at admin+data/multi-user),
// so the seeded owner has no `task_changes` preference row at all going into this test, on either
// a fresh UAT DB or the shared non-reset one (once healed, TasksCompatibilityHelper always returns
// the stored value going forward, so a rerun against an already-healed row still observes
// `{enabled: true}` — this test does not depend on being first).
//
// The other half of the plan's exit criterion — that a `granted_at_install` tool dispatch renders
// no `.action-request-card` — is proven for real without a model at the integration layer, the
// same way 1264's sibling spec does it: tests/integration/mcp-gateway-self-operation.test.ts
// ("first use after install grant runs without an action card") exercises the real
// AssistantToolGateway.callTool dispatch path and asserts the ONLY emitted record is
// `action_result`, never `action_request`. `packages/tasks/src/action-policy.ts`'s
// `getResolvedTaskChangesPolicy` feeds that same choke point
// (`resolvePolicy`, packages/ai/src/gateway/policy.ts) once healed, so this is not a separate code
// path per tool. `test.fixme`s the real-chat-driven dispatch below, citing #1121.
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors 1264-settings-self-operation.uat.spec.ts's signIn(): `solo-admin` returns before the
// onboarding chunk, so the seeded owner still has first-run onboarding pending. Skip it only when
// shown.
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

// Real, cookie-authed request against the running server — no chat turn or model needed. Proves
// the #1311 tasks-side fix (packages/tasks/src/action-policy.ts's
// `getResolvedTaskChangesPolicy` both-absent branch) holds against a real DB and a real owner who
// never had a `task_changes` row, not just the mocked-injection integration test
// (tests/integration/tasks-action-policy-self-heal.test.ts) or the fastify-inject contract test
// (tests/integration/tasks-web-contract.test.ts).
test("tasks agency-auto-execute self-heals to enabled on first read, no prior enable action", async ({
  page
}) => {
  await signIn(page);

  const body = await page.evaluate(async () => {
    const response = await fetch("/api/tasks/agency-auto-execute");
    return { status: response.status, json: await response.json() };
  });

  expect(body.status).toBe(200);
  expect(body.json).toEqual({ enabled: true });
});

// #1121: needs a real, instruction-following chat model to actually dispatch a granted_at_install
// tasks tool (e.g. reprioritizing a task) via a chat turn and observe no Approve/Reject card. The
// UAT harness has no chat-capable AI provider at any seed level (see file header), so no seed
// level can drive this turn. The mechanism this test would exercise (granted install-time trust ->
// action_result only, never action_request) is proven for real without a model at the integration
// layer by tests/integration/mcp-gateway-self-operation.test.ts ("first use after install grant
// runs without an action card"), which drives the real AssistantToolGateway.callTool dispatch path
// through the same resolvePolicy choke point (packages/ai/src/gateway/policy.ts) this tool would
// hit. Deferred until #1121's scriptable UAT chat engine exists.
test.fixme("chat dispatches a task_changes tool with no confirmation card (#1121)", async () => {});
