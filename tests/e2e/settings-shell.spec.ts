import type { GetQuietHoursSettingsResponse } from "@moss/shared";
import { expect, test, type Page } from "@playwright/test";

import { createMockUser, mockApi } from "./mock-api.js";
import { createMockAiModel, createMockAiProvider } from "./mock-ai-api.js";
import { myModulesResponse } from "./mock-modules.js";

async function mockSettingsApi(
  page: Page,
  isInstanceAdmin = true,
  aiProviders?: ReturnType<typeof createMockAiProvider>[]
): Promise<void> {
  await mockApi(page, {
    authenticated: true,
    isInstanceAdmin,
    ...(aiProviders ? { aiProviders } : {}),
    adminUsers: isInstanceAdmin
      ? [
          createMockUser("user-1", "Owner User", "owner@example.test", {
            isInstanceAdmin: true,
            isBootstrapOwner: true
          }),
          createMockUser("pending-1", "Pending User", "pending@example.test", {
            status: "pending"
          }),
          createMockUser("member-1", "Member User", "member@example.test")
        ]
      : undefined,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });

  await page.route("**/api/me/quiet-hours", (route) =>
    route.fulfill({
      json: {
        quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
        authority: { status: "default", alerts: null },
        version: null
      } satisfies GetQuietHoursSettingsResponse
    })
  );
  if (isInstanceAdmin) {
    await page.route("**/api/admin/registration", (route) =>
      route.fulfill({ json: { registrationEnabled: true, requiresApproval: true } })
    );
  }
}

test("reaffirms a selected Codex model and clears the saved OpenCode choice", async ({ page }) => {
  const codex = createMockAiModel("codex", {
    providerKind: "openai-compatible",
    providerDisplayName: "Codex",
    providerModelId: "gpt-5-codex",
    displayName: "Codex"
  });
  let chatSettings: { chat: { responseStyle: "balanced"; openCodeModel?: string } } = {
    chat: { responseStyle: "balanced", openCodeModel: "muse-spark-1.3-free" }
  };

  await mockSettingsApi(page);
  await page.route("**/api/ai/chat-model-override", async (route) => {
    await route.fulfill({
      json: {
        settings: {
          overrideEnabled: true,
          currentOverrideModelId: "codex",
          effectiveOverrideModelId: "codex",
          defaultModel: codex,
          selectedModel: codex,
          selectableOverrideModels: [codex]
        }
      }
    });
  });
  await page.route("**/api/chat/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { chat: typeof chatSettings.chat };
      chatSettings = { chat: input.chat };
    }
    await route.fulfill({ json: chatSettings });
  });

  await page.goto("/settings?section=assistant");
  await expect(page.getByRole("heading", { name: "Your assistant" })).toBeVisible();
  await expect(page.getByLabel("Chat model")).toHaveValue("codex");

  const reaffirm = page.getByRole("button", { name: "Use Codex for chat" });
  await expect(reaffirm).toBeVisible();
  await reaffirm.click();
  await expect.poll(() => chatSettings.chat.openCodeModel).toBeUndefined();
  await expect(page.getByRole("button", { name: "Use Codex for chat" })).toHaveCount(0);
});

test("reaffirms the Codex admin default and clears the saved OpenCode choice", async ({ page }) => {
  const codex = createMockAiModel("codex", {
    providerKind: "openai-compatible",
    providerDisplayName: "Codex",
    providerModelId: "gpt-5-codex",
    displayName: "Codex"
  });
  let chatSettings: { chat: { responseStyle: "balanced"; openCodeModel?: string } } = {
    chat: { responseStyle: "balanced", openCodeModel: "muse-spark-1.3-free" }
  };

  await mockSettingsApi(page);
  await page.route("**/api/ai/chat-model-override", async (route) => {
    await route.fulfill({
      json: {
        settings: {
          overrideEnabled: true,
          currentOverrideModelId: null,
          effectiveOverrideModelId: null,
          defaultModel: codex,
          selectedModel: codex,
          selectableOverrideModels: [codex]
        }
      }
    });
  });
  await page.route("**/api/chat/settings", async (route) => {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON() as { chat: typeof chatSettings.chat };
      chatSettings = { chat: input.chat };
    }
    await route.fulfill({ json: chatSettings });
  });

  await page.goto("/settings?section=assistant");
  await expect(page.getByRole("heading", { name: "Your assistant" })).toBeVisible();
  await expect(page.getByLabel("Chat model")).toHaveValue("default");

  const reaffirm = page.getByRole("button", { name: "Use Codex for chat" });
  await expect(reaffirm).toBeVisible();
  await reaffirm.click();
  await expect.poll(() => chatSettings.chat.openCodeModel).toBeUndefined();
  await expect(page.getByRole("button", { name: "Use Codex for chat" })).toHaveCount(0);
});

test("desktop shell renders grouped IA, merged panes, and history-aware mode changes", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  const nav = page.getByRole("navigation", { name: "Settings categories" });
  for (const group of ["Your account", "Moss", "Connections", "Extensions"]) {
    await expect(nav.locator(".set2__navgroup", { hasText: group })).toBeVisible();
  }
  await expect(nav.getByRole("button")).toHaveCount(11);
  await expect(
    nav.getByRole("button", { name: "Alerts & quiet hours", exact: true })
  ).toBeVisible();
  await expect(nav.getByRole("button", { name: "What's new" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Connections" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Profile & account" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "General" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  for (const section of [
    "Account",
    // Renamed from "Locale" by the recovered 2026-07-19 profile polish: the group now holds a time
    // zone plus a (disabled) language & region control, so "Location" describes it honestly.
    "Location",
    "Weather",
    "Quiet hours",
    "Active sessions",
    "Your data",
    "Danger zone"
  ]) {
    // .first(): the Weather group also has a "Location" field label, so the exact-text match
    // can resolve to two elements; the group title is the first in document order.
    await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
  }

  await nav.getByRole("button", { name: "Modules" }).click();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();

  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await expect(page).toHaveURL(/\?section=people$/);
  for (const group of ["Access", "AI & extensions", "Operations"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(nav.getByRole("button")).toHaveCount(7);
  await expect(nav.getByRole("button", { name: "Encryption keys" })).toBeVisible();
  // #2956 slice D retired the admin Model activity page; Activity covers it.
  await expect(nav.getByRole("button", { name: "Model activity" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Identity & registration" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
  for (const section of ["Registration", "Pending approval", "Members"]) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Actions for Member User" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("button", { name: "Personal" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\?section=people$/);
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
});

test("short desktop rail reaches its final destination by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  const nav = page.getByRole("navigation", { name: "Settings categories" });
  const first = nav.getByRole("button", { name: "Account & preferences" });
  const last = nav.getByRole("button").last();
  await expect(first).toBeVisible();
  const destinations = await nav.getByRole("button").count();
  await first.focus();
  for (let index = 1; index < destinations; index += 1) await page.keyboard.press("Tab");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
});

test("narrow shell keeps groups and destinations reachable without horizontal overflow", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSettingsApi(page);
  await page.goto("/settings");

  // While the sheet is open the list is a dialog, so address it by id rather than by role.
  const nav = page.locator("#settings-sections");
  const picker = page.getByRole("button", { name: /^Section/ });

  // State 1: nothing chosen yet shows the whole list and no pane.
  for (const group of ["Your account", "Moss", "Connections", "Extensions"]) {
    await expect(nav.locator(".set2__navgroup", { hasText: group })).toBeVisible();
  }
  await expect(picker).toBeHidden();
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeHidden();

  // State 2: choosing a section folds the list into the bar.
  await nav.getByRole("button", { name: "Modules" }).click();
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
  await expect(nav).toBeHidden();
  await expect(picker).toContainText("Modules");

  // State 3: the bar brings the list back as a sheet; Escape closes it and returns focus.
  await picker.click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: "Account & preferences" })).toBeVisible();
  // The open sheet is a labelled modal dialog and the rest of the app, chat button included, is
  // unreachable behind it.
  await expect(page.getByRole("dialog", { name: "Settings sections" })).toBeVisible();
  await expect(nav).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("main, header").first()).toBeAttached();
  expect(
    await page.evaluate(() => {
      const chat = [...document.querySelectorAll("button")].find((b) =>
        /chat with/i.test(b.getAttribute("aria-label") ?? "")
      );
      return chat ? Boolean(chat.closest("[inert]")) : true;
    })
  ).toBe(true);
  // Tab wraps inside the sheet in both directions.
  const items = nav.getByRole("button");
  await items.last().focus();
  await page.keyboard.press("Tab");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(picker).toBeFocused();

  await picker.click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  await expect(nav).toBeHidden();
  await expect(picker).toBeFocused();

  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible();
  await picker.click();
  for (const group of ["Access", "AI & extensions", "Operations"]) {
    await expect(nav.getByText(group, { exact: true })).toBeVisible();
  }
  await nav.getByRole("button", { name: "People & access" }).focus();
  await expect(nav.getByRole("button", { name: "People & access" })).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("non-admin direct admin deep link mounts no admin surface or request", async ({ page }) => {
  await mockSettingsApi(page, false);
  const adminRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/")) {
      adminRequests.push(request.url());
    }
  });

  await page.goto("/settings?section=people");

  await expect(page.getByRole("heading", { name: "Account & preferences" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin / Setup" })).toHaveCount(0);
  await expect(page.getByText("People & access", { exact: true })).toHaveCount(0);
  expect(adminRequests).toEqual([]);
});

test("modules preserve list/detail URL recovery for legacy and contributed settings", async ({
  page
}) => {
  await mockSettingsApi(page);
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...myModulesResponse.modules,
          {
            id: "sports",
            name: "Sports",
            version: "0.1.0",
            lifecycle: "user-toggleable",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true
          }
        ]
      }
    })
  );
  await page.route("**/api/sports/catalog", (route) =>
    route.fulfill({ json: { competitions: [], degraded: false } })
  );
  await page.route("**/api/sports/follows", (route) => route.fulfill({ json: { follows: [] } }));
  await page.goto("/settings?section=modules");

  for (const moduleName of ["Briefings", "Notifications", "Sports"]) {
    await expect(page.getByRole("button", { name: `Configure ${moduleName}` })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Configure Chat" })).toHaveCount(0);
  for (const requiredName of ["Briefings", "Notifications"]) {
    await expect(page.getByRole("checkbox", { name: `Use ${requiredName}` })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Configure Briefings" }).click();
  await expect(page).toHaveURL(/section=modules&module=briefings$/);
  await expect(page.getByRole("button", { name: "Back to modules" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();

  await page.getByRole("button", { name: "Configure Sports" }).click();
  await expect(page).toHaveURL(/section=modules&module=sports$/);
  await expect(page.getByRole("button", { name: "Back to modules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sports" })).toBeVisible();
  await page.getByRole("button", { name: "Back to modules" }).click();
  await expect(page).toHaveURL(/\?section=modules$/);

  await page.getByRole("button", { name: "Configure Sports" }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Modules" })
    .click();
  await expect(page).toHaveURL(/\?section=modules$/);
  await expect(page.getByRole("heading", { name: "Modules" })).toBeVisible();
});

test("data export resumes across remount and clears on new/expired job", async ({ page }) => {
  await mockSettingsApi(page);

  let job1Status: "pending" | "building" | "ready" = "pending";
  let postCount = 0;
  await page.route("**/api/me/export", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    postCount += 1;
    job1Status = "building";
    await route.fulfill({ json: { jobId: "job-1", status: "pending" } });
  });
  await page.route("**/api/me/export/status/job-1", (route) =>
    route.fulfill({ json: { jobId: "job-1", status: job1Status } })
  );

  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings categories" });

  // 1. Baseline: start an export, building state renders.
  await page.getByRole("button", { name: "Prepare export" }).click();
  await expect(page.getByText("Building your archive…")).toBeVisible();
  expect(postCount).toBe(1);

  // 2. Remount DataExport by navigating away and back; the job resumes, no second POST.
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByText("Building your archive…")).toBeVisible();
  expect(postCount).toBe(1);

  // 3. Once ready, the Download link targets the resumed job id.
  job1Status = "ready";
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "/api/me/export/download/job-1"
  );

  // 4. "Prepare a new export" clears the persisted id, not just in-memory state.
  await page.getByRole("button", { name: "Prepare a new export" }).click();
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
  ).toBeNull();

  // 5. A resumed-but-gone job (404) falls back to idle and clears storage.
  await page.addInitScript(() => {
    window.sessionStorage.setItem("moss.settings.export-job-id", "job-2");
  });
  await page.route("**/api/me/export/status/job-2", (route) =>
    route.fulfill({ status: 404, json: { message: "not found" } })
  );
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
  ).toBeNull();
});

test("assistant persona controls never run under the preview at in-between widths", async ({
  page
}) => {
  await mockSettingsApi(page);
  for (const width of [900, 1000, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings?section=assistant");
    await expect(page.getByLabel("Assistant name")).toBeVisible();
    const clash = await page.evaluate(() => {
      const preview = document.querySelector(".psona > .ppv")?.getBoundingClientRect();
      const fields = [
        ...document.querySelectorAll(".psona__controls input, .psona__controls textarea")
      ];
      if (!preview) return "no preview";
      return fields.some((field) => {
        const r = field.getBoundingClientRect();
        return (
          r.right > preview.left + 0.5 &&
          r.left < preview.right &&
          r.bottom > preview.top &&
          r.top < preview.bottom
        );
      });
    });
    expect(clash, `overlap at ${width}px`).toBe(false);
  }
});

test("phone provider More menu stays fully visible, including Remove", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSettingsApi(page, true, [
    createMockAiProvider("p1", { displayName: "Short Provider" })
  ]);
  await page.goto("/settings?section=aiproviders");
  await page.getByRole("button", { name: "More actions for Short Provider" }).click();
  const remove = page.getByRole("menuitem", { name: "Remove" });
  await expect(remove).toBeVisible();
  const box = await remove.boundingBox();
  if (!box) throw new Error("Remove has no box");
  const hit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x as number, y as number)?.textContent?.trim(),
    [box.x + box.width / 2, box.y + box.height / 2] as const
  );
  expect(hit).toBe("Remove");
});
