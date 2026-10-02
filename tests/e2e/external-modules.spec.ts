import { test, expect } from "@playwright/test";

import { mockApi } from "./mock-chat-model.js";
import { mockExternalModules, mockExternalWebModule } from "./mock-modules.js";

// #917 (Open module system, Slice 1 — Task 10): the admin Settings → Instance modules
// pane surfaces user-authored "external" modules discovered on the box, with a
// trusted-operator warning and a per-module enable toggle. This spec proves the section
// renders (feature-on) and that enabling a module round-trips through the API mock.
test.describe("External modules admin pane (#917)", () => {
  test("admin sees the trusted-operator warning and can enable a module", async ({ page }) => {
    // mockApi seeds an admin user by default (isInstanceAdmin ?? true). mockExternalModules is
    // registered AFTER so its routes win over mockApi's catch-all 404 for /api/*.
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockExternalModules(page);

    await page.goto("/settings");
    // Switch to the admin surface, then open the Instance modules pane. Settings nav items are
    // buttons (mirrors app-shell.spec.ts's People & access flow), not links.
    await page.getByRole("button", { name: "Admin / Setup" }).click();
    await page.getByRole("button", { name: "Instance modules" }).click();
    await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();

    // The External modules section + its trusted-operator warning are present. `exact` so the
    // section title doesn't also match the warning paragraph, which begins "External modules …".
    await expect(page.getByText("External modules", { exact: true })).toBeVisible();
    await expect(page.getByText(/only enable modules you authored or fully trust/i)).toBeVisible();

    // The authored Switch renders an <input type="checkbox">, so its ARIA role is `checkbox`
    // (NOT `switch`). The native input is visually hidden (opacity:0; 0×0) — the wrapping
    // <label.jds-switch> is the clickable surface — so assert visibility/click on the label and
    // read checked state from the input. Starts unchecked (status "discovered").
    const toggle = page.getByRole("checkbox", { name: /enable acme widgets/i });
    const toggleLabel = page.locator("label.jds-switch", { has: toggle });
    await expect(toggleLabel).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // Enabling POSTs to the mock, which flips status → "enabled"; the mutation invalidates the
    // list query so the refetch re-renders the switch checked.
    await toggleLabel.click();
    await expect(page.getByRole("checkbox", { name: /enable acme widgets/i })).toBeChecked();
  });
});

test.describe("External module host starter action (#916)", () => {
  test("keyboard-activating the module button opens an editable draft, never auto-sent", async ({
    page
  }) => {
    // Flag any chat-turn POST — the whole point is that NO turn is sent until the user submits.
    let turnPosted = false;
    await page.route("**/api/chat/turn", async (route) => {
      turnPosted = true;
      await route.fulfill({ json: { userMessageId: "u1", assistantMessageId: "a1", reply: "hi" } });
    });

    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockExternalWebModule(page);

    await page.goto("/m/demo-module");

    await expect(page.locator('[data-assistant-surface="available"]')).toHaveText(
      "Assistant surface available"
    );

    // Keyboard activation (a11y basic): focus the module button and press Enter.
    const button = page.getByRole("button", { name: "Continue with Jarvis" });
    await expect(button).toBeVisible();
    await button.press("Enter");

    // The drawer opened and the composer holds the exact starter as an editable, focused draft.
    const composer = page.getByRole("textbox", { name: "Message Moss" });
    await expect(composer).toHaveValue("Help me start.");
    await expect(composer).toBeFocused();

    // No message was submitted and no tool ran — send stays a manual action.
    expect(turnPosted).toBe(false);
  });
});
