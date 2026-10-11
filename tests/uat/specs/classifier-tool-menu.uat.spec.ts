import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Classifier gate plan 2.3 (#2883, ruling 2: calendar only). This proves the real, installed
// Calendar module that owns the opted-in tool is reachable through the real UI, and that the read
// surface the tool wraps answers for the actor. The gated execution path itself is NOT provable
// here: no production code builds the gate's tool menu from installed manifests yet — that wiring is
// slice 3.5, and its live UI proof lands with 4.3. The declaration-to-menu path is proven
// deterministically in tests/unit/calendar-classifier-menu.test.ts, and the handler behavior in
// tests/unit/calendar-classifier-tool.test.ts.
//
// The "default chat is unchanged" half needs a real chat turn; the UAT harness has no chat-capable
// AI provider at any seed level (#1121), so it is test.fixme'd below with that citation.
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
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

async function json(
  page: Page,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: await response.json() };
    },
    { path, init }
  );
}

test("the calendar tool's module is installed and its read surface is reachable", async ({
  page
}) => {
  test.setTimeout(120_000);
  await signIn(page);

  // 1. The bundled module is installed and enabled for this actor. /api/modules returns the real
  // ModuleDto (id, name, version, lifecycle, navigation, settings, external) — there is no `active`
  // or `required` field, so assert on what the response actually carries.
  const modules = await json(page, "/api/modules");
  expect(modules.status).toBe(200);
  const calendar = (
    modules.body.modules as Array<{
      id: string;
      lifecycle: string;
      external?: boolean;
      navigation: Array<{ path: string }>;
    }>
  ).find((module) => module.id === "calendar");
  expect(calendar, "Calendar is a bundled module").toBeTruthy();
  expect(calendar!.lifecycle).toBe("required");
  expect(calendar!.external).toBe(false);
  expect(calendar!.navigation.map((entry) => entry.path)).toContain("/calendar");

  // 2. The real Calendar surface loads through the app's own navigation (no goto shortcut).
  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/calendar/);
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
  await expect(
    page.getByRole("group", { name: "View" }).getByRole("button", { name: "Day" })
  ).toBeVisible();

  // 3. The read surface behind the opted-in tool answers for this actor.
  const events = await json(page, "/api/calendar/events");
  expect(events.status).toBe(200);
  expect(Array.isArray(events.body.events)).toBe(true);
});

test.fixme("an ordinary chat message is still answered by the main model while the gate is unreleased", async () => {
  // #1121: no UAT seed level can drive a real chat turn to a model reply, so this cannot execute
  // yet. When 3.5 wires the gate, this spec is extended (classifier-tool-menu -> shadow proof).
});
