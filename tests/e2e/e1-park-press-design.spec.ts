import { captureVisualArtifact } from "./visual-artifacts.js";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { buildExternalModule } from "../../scripts/build-external-module.js";
import { mockApi } from "./mock-api.js";
import { modulesResponse, myModulesResponse } from "./mock-modules.js";

// Actual Finance and host source with synthetic API responses. These are presentation and
// interaction regressions, not live-path acceptance or evidence of financial writes.
let bundle: string;
test.beforeAll(async () => {
  await buildExternalModule("external-modules/finance");
  bundle = await readFile("external-modules/finance/dist/web/index.js", "utf8");
});

async function financeSettings(page: Page, failure = false) {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
  await page.route("**/api/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...modulesResponse.modules,
          {
            id: "finance",
            name: "Finance",
            version: "0.6.8",
            lifecycle: "optional",
            external: true,
            web: { entrypoint: "dist/web/index.js", contractVersion: 2 },
            navigation: [{ id: "finance", label: "Finance", path: "/m/finance", order: 60 }],
            settings: []
          }
        ]
      }
    })
  );
  await page.route("**/api/me/modules", (route) =>
    route.fulfill({
      json: {
        modules: [
          ...myModulesResponse.modules,
          {
            id: "finance",
            name: "Finance",
            version: "0.6.8",
            lifecycle: "optional",
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: true,
            hasUserCredentials: false,
            scope: "everyone"
          }
        ]
      }
    })
  );
  await page.route("**/api/modules/finance/web/dist/web/index.js*", (route) =>
    route.fulfill({
      contentType: "text/javascript; charset=utf-8",
      body: bundle
    })
  );
  await page.route("**/api/ai/action-policy", (route) => route.fulfill({ json: { policies: [] } }));
  await page.route("**/api/modules/finance/preferences", (route) =>
    route.fulfill(
      failure
        ? { status: 503, json: { error: "Synthetic read failure" } }
        : {
            json: { preferences: [{ key: "freedomLimitDollars", value: 250, default: 100 }] }
          }
    )
  );
  await page.route("**/api/admin/modules/finance/credentials", (route) =>
    route.fulfill({ status: 403, json: {} })
  );
  await page.route("**/api/ai/assistant-tools/finance.activity.list/invoke", (route) =>
    route.fulfill({
      json: { invocation: { status: "succeeded", result: { activity: [] } } }
    })
  );
  await page.goto("/m/finance/settings");
  await expect(page.getByRole("heading", { name: "How much Moss does alone" })).toBeVisible();
}

for (const width of [1440, 1080, 768, 390, 320]) {
  for (const theme of ["light", "dark", "sage"] as const) {
    test(`Finance disclosure stays separate from its phone hit target: ${width}/${theme}`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await financeSettings(page);
      await expect(page.getByLabel("Moss can move up to, per move")).toHaveValue("$250");
      await page.evaluate((current) => {
        document.documentElement.dataset.colorMode = current === "dark" ? "dark" : "light";
        document.documentElement.dataset.theme = current === "sage" ? "sage" : "forest";
      }, theme);
      const disclosure = page.getByRole("button", { name: "Customize", exact: true });
      await disclosure.scrollIntoViewIfNeeded();
      const geometry = await disclosure.evaluate((button) => {
        const marker = button.querySelector(".fnm-disclosure-marker")!;
        const range = document.createRange();
        range.selectNodeContents(button.firstChild!);
        const text = range.getBoundingClientRect();
        const mark = marker.getBoundingClientRect();
        const target = getComputedStyle(button, "::after");
        return {
          gap: mark.left - text.right,
          markerPosition: getComputedStyle(marker).position,
          targetHeight: target.height,
          targetPosition: target.position,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
      });
      expect(geometry.gap).toBeGreaterThanOrEqual(5);
      expect(geometry.markerPosition).toBe("static");
      if (width <= 600) {
        expect(geometry.targetPosition).toBe("absolute");
        expect(Number.parseFloat(geometry.targetHeight)).toBeGreaterThanOrEqual(44);
      }
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("checkbox", { name: "Move money between categories" })
      ).toBeEnabled();
      await captureVisualArtifact(page, `finance-settings-${width}-${theme}.png`);
      await page.keyboard.press("Space");
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    });
  }
}

test("Finance failed limit read is visible, disabled and recoverable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await financeSettings(page, true);
  await expect(page.getByRole("alert")).toContainText("Couldn't load your dollar limit.");
  const limit = page.getByLabel("Moss can move up to, per move");
  await expect(limit).toHaveValue("");
  await expect(limit).toBeDisabled();
  await expect(page.getByRole("radio").first()).toBeDisabled();
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).toBeDisabled();
  await captureVisualArtifact(page, "finance-settings-read-failure.png");
  await page.route("**/api/modules/finance/preferences", (route) =>
    route.fulfill({
      json: { preferences: [{ key: "freedomLimitDollars", value: 250 }] }
    })
  );
  await page.getByRole("button", { name: "Retry loading settings" }).click();
  await expect(limit).toHaveValue("$250");
  await expect(limit).toBeEnabled();
  await expect(page.getByRole("radio").first()).toBeEnabled();
});
