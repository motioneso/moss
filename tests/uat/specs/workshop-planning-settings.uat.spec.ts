import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

async function openAiSettings(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Assistant & AI" }).click();
}

test("Workshop planning keeps reasoning choices, saved bindings and stale-model recovery", async ({
  page
}) => {
  test.setTimeout(120_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();

  // Use real authenticated configuration APIs for setup. No provider test, discovery or chat call.
  const created = await page.request.post("/api/ai/providers", {
    data: {
      providerKind: "openai-compatible",
      displayName: "Workshop UAT provider",
      baseUrl: "http://127.0.0.1:9",
      credentialPayload: { apiKey: "synthetic-workshop-only" }
    }
  });
  expect(created.status()).toBe(201);
  const provider = (await created.json()).provider;
  expect(provider.baseUrl).toBe("http://127.0.0.1:9");
  const providerConfigId = provider.id as string;
  const models = [
    { providerModelId: "uat-workshop-reasoning", tier: "reasoning", capabilities: ["json"] },
    { providerModelId: "uat-workshop-interactive", tier: "interactive", capabilities: ["json"] },
    { providerModelId: "uat-workshop-no-json", tier: "reasoning", capabilities: ["chat"] }
  ];
  let reasoningId = "";
  for (const model of models) {
    const response = await page.request.post("/api/ai/models", {
      data: {
        providerConfigId,
        ...model,
        displayName: model.providerModelId
      }
    });
    expect(response.status()).toBe(201);
    if (model.providerModelId === "uat-workshop-reasoning") {
      reasoningId = (await response.json()).model.id as string;
    }
  }

  await openAiSettings(page);
  const binding = page.getByRole("combobox", { name: "Binding for Workshop planning" });
  await expect(binding).toHaveValue("mode:reasoning");
  await expect(binding.locator("option")).toHaveText(["Reasoning", "uat-workshop-reasoning"]);
  await expect(
    page.getByText("Routing and connection checked when planning.", { exact: true })
  ).toBeVisible();

  const save = async (value: string) => {
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "PUT" &&
        item.url().endsWith("/api/ai/services/module.workshop.plan/binding")
    );
    await binding.selectOption(value);
    expect((await response).status()).toBe(200);
    await expect(binding).toBeEnabled();
  };
  await save(`model:${reasoningId}`);
  await page.reload();
  await expect(binding).toHaveValue(`model:${reasoningId}`);

  const disabled = await page.request.patch(`/api/ai/models/${reasoningId}`, {
    data: { status: "disabled" }
  });
  expect(disabled.status()).toBe(200);
  await page.reload();
  await expect(binding).toHaveValue(`model:${reasoningId}`);
  await expect(binding.locator("option:checked")).toHaveText("Selected model needs configuration");
  await expect(binding.locator("option:checked")).toBeDisabled();
  await save("mode:reasoning");
  await page.reload();
  await expect(binding).toHaveValue("mode:reasoning");
});
