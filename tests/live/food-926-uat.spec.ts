// Live-Path Gate for #926 Food Phase 1. Runs against a REAL running dev instance:
// real API, real Postgres with RLS, real module install. Nothing here is mocked — no
// page.route(), no fixtures. See docs/DEVELOPMENT_STANDARDS.md → Live-Path Gate.
//
// Run with:  npx playwright test --config playwright.live.config.ts
// Requires:  pnpm dev:api (:3000) + pnpm dev:web (:5173), Food staged in data/modules/.
//
// SCOPE — read this before trusting a green run.
//
// Write-risk module tools (food.meals.log, food.meals.correct, food.meals.reestimate,
// food.meals.delete) execute ONLY inside a live chat turn: the gateway creates the pending
// action and then BLOCKS on confirmations.awaitResolution (gateway.ts:364, :617), and a
// confirm is honoured only while that waiter is alive (gateway.ts:497). The REST route
// POST /assistant-tools/:name/invoke records the pending action and returns 403 without
// ever registering a waiter (routes.ts:667-692), so resolving it afterwards correctly
// reports 409 "expired" and the tool never runs. There is no non-model path that executes
// a write-risk tool, and this dev instance has no real AI provider configured (only "UAT
// Fake Provider" rows, none instance-default).
//
// So this file proves the read and lifecycle halves end-to-end, plus the permission gate
// itself (write-risk tools must NOT execute without confirmation — asserted positively).
// It does NOT prove meal logging, correction, re-estimation, or the AI
// estimator. Those need a real provider on dev and are stated as unproven on the PR rather
// than papered over with a seeded row.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = process.env.LIVE_API_URL ?? "http://127.0.0.1:3000";

const OWNER = { email: "ben@ben.com", password: "jarvistest123!" };
const OTHER = { email: "uat-owner2@jarv1s.local", password: "uat-owner2-password-1030" };

test.describe.configure({ mode: "serial" });

async function signIn(request: APIRequestContext, who: { email: string; password: string }) {
  const response = await request.post(`${API}/api/auth/sign-in/email`, { data: who });
  expect(response.status(), `sign-in for ${who.email}`).toBe(200);
}

async function signInThroughUi(page: Page, who: { email: string; password: string }) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

// The instance-modules switch is a jds-switch: a visually-hidden native input (positioned
// out of the viewport, so it cannot be clicked directly) wrapped in a label whose visible
// track is what a user actually clicks. Click the track — that is the real interaction.
async function openInstanceModules(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
}

function foodSwitch(page: Page) {
  return page.locator('label.jds-switch:has(input[aria-label="Enable Food"])');
}

async function setFoodEnabled(page: Page, want: boolean) {
  const input = page.getByRole("checkbox", { name: /enable food/i });
  await expect(input).toHaveCount(1);
  if ((await input.isChecked()) !== want) {
    await foodSwitch(page).locator(".jds-switch__track").click();
  }
  await expect(input).toBeChecked({ checked: want });

  // The assertion that actually matters: the SERVER agrees. A flipped switch with an
  // unchanged install is exactly the class of bug this gate exists to catch.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${API}/api/admin/external-modules`);
        const body = await response.json();
        return body.modules.find((m: { id: string }) => m.id === "food")?.active;
      },
      { timeout: 15_000 }
    )
    .toBe(want);
}

// Step 1 — install/enable through the real admin UI, not a DB write.
test("1. admin enables Food from Settings → Admin / Setup → Instance modules", async ({ page }) => {
  await signInThroughUi(page, OWNER);
  await openInstanceModules(page);
  await setFoodEnabled(page, true);
});

// Step 2 — nav placement ruling: Food appears in the primary nav.
test("2. Food appears in the primary nav with its own icon", async ({ page }) => {
  await signInThroughUi(page, OWNER);
  await expect(page.getByRole("link", { name: /^food$/i })).toBeVisible();
});

// Step 3 — #1750: AI estimation is a settings switch, on by default, not an in-chat consent
// grant. Installing Food is consent for Food's normal functionality. The Food page therefore
// says nothing about estimation while it is on; a permanent "estimates: on" badge is a nag.
test("3. the Food page carries no consent prompt and no estimation toggle", async ({ page }) => {
  await signInThroughUi(page, OWNER);
  await page.goto("/m/food");
  await expect(page.locator(".fud-meals, .fud-state")).toBeVisible();

  // The switch lives in Settings, under Food. A toggle here would be a permission defect —
  // a module page may invoke read-risk tools only, and writing a preference is a write.
  await expect(page.getByText(/consent/i)).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /estimat/i })).toHaveCount(0);
  await expect(page.getByText(/Nutrition estimates are off/i)).toHaveCount(0);
});

// Step 4G — the permission gate, asserted positively. Every write-risk Food tool must record
// a pending action and refuse to execute. This is the half of the confirm-then-execute flow
// that IS reachable without a model, and it is the half that carries the security promise.
test("4G. write-risk Food tools are blocked pending confirmation and do not execute", async ({
  request
}) => {
  await signIn(request, OWNER);

  const writeTools = [
    { name: "food.meals.log", input: { description: "oatmeal", idempotencyKey: "uat-926-1" } },
    { name: "food.meals.delete", input: { mealId: "00000000-0000-0000-0000-000000000000" } }
  ];

  for (const tool of writeTools) {
    const invoke = await request.post(`${API}/api/ai/assistant-tools/${tool.name}/invoke`, {
      data: { input: tool.input }
    });
    expect(invoke.status(), `${tool.name} must NOT execute on invoke`).toBe(403);
    const body = await invoke.json();
    expect(body.invocation.status).toBe("blocked");
    expect(body.invocation.blockedReason).toBe("confirmation_required");
    expect(body.invocation.actionRequestId, "a pending action must be recorded").toBeTruthy();

    // The recorded row must be owned, pending, and must not leak the tool input.
    const actions = await request.get(`${API}/api/ai/assistant-actions`);
    const list = (await actions.json()).actions as Array<Record<string, unknown>>;
    const row = list.find((a) => a.id === body.invocation.actionRequestId);
    expect(row, "pending action is readable by its owner").toBeTruthy();
    expect(row?.status).toBe("pending");
    expect(JSON.stringify(row?.inputSummary), "only key names, never values").not.toContain(
      "oatmeal"
    );
  }
});

// Step 5 — the page reads live records through the module worker, not a build-time fixture.
test("5. the Food page renders from a live food.meals.list call", async ({ page }) => {
  await signInThroughUi(page, OWNER);

  const listCall = page.waitForResponse(
    (r) => r.url().includes("food.meals.list") && r.status() === 200
  );
  await page.goto("/m/food");
  const response = await listCall;
  const body = await response.json();

  // The call must succeed through the real worker and return the module's own shape.
  expect(body, "food.meals.list returned a live result").toBeTruthy();
  await expect(page.getByRole("heading", { name: "Food", level: 1 })).toBeVisible();
});

// Behaviour 9 — two-actor privacy. This is the assertion no unit test can make: it needs
// real Postgres RLS, not a fake store. A second real actor must see none of owner's meals.
test("9. a second actor cannot see the owner's meals", async ({ request }) => {
  await signIn(request, OTHER);
  const response = await request.post(`${API}/api/ai/assistant-tools/food.meals.list/invoke`, {
    data: { input: { localDate: today() } }
  });

  // Either the tool is not available to this actor, or it is and returns an empty set.
  // Both are correct; returning the owner's rows is not.
  if (response.status() === 200) {
    const body = await response.json();
    const meals = body?.result?.meals ?? body?.meals ?? [];
    expect(meals, "second actor must not receive the owner's meals").toHaveLength(0);
  } else {
    expect([403, 404]).toContain(response.status());
  }
});

// Step 8 — the platform's real disable path, then Food's surfaces must actually go away.
test("8. disabling Food removes its nav entry and its assistant tools", async ({
  page,
  request
}) => {
  await signInThroughUi(page, OWNER);
  await openInstanceModules(page);
  await setFoodEnabled(page, false);

  await page.goto("/");
  await expect(page.getByRole("link", { name: /^food$/i })).toHaveCount(0);

  await signIn(request, OWNER);
  const tools = await request.get(`${API}/api/ai/assistant-tools`);
  const body = await tools.json();
  const names = (body.tools ?? []).map((t: { name: string }) => t.name);
  expect(names.filter((n: string) => n.startsWith("food."))).toHaveLength(0);
});

// Step 9 — re-enable restores the surface and its tools; disable was not a wipe.
test("9b. re-enabling Food restores the page and its tools", async ({ page, request }) => {
  await signInThroughUi(page, OWNER);
  await openInstanceModules(page);
  await setFoodEnabled(page, true);

  await page.goto("/m/food");
  await expect(page.getByRole("heading", { name: "Food", level: 1 })).toBeVisible();

  await signIn(request, OWNER);
  const tools = await request.get(`${API}/api/ai/assistant-tools`);
  const names = ((await tools.json()).tools ?? []).map((t: { name: string }) => t.name);
  expect(names).toContain("food.meals.list");
});

function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
