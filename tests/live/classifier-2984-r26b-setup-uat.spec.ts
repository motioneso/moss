// Live-Path Gate for #2984 R2.6, rerun setup: a fresh owner, the Codex sign-in as the main chat
// model, one connection to the stand-in tool server, sorted and prepared with the classifier on.
//
// Run before classifier-2984-r26-chat-uat.spec.ts (tests 7, 10, 11 and 12) on the same scratch
// database. Real API, real worker, real models. Nothing is intercepted.
//
// Extra variables: LIVE_R26_DB_CONTAINER and LIVE_R26_DB name the scratch database;
// LIVE_R26_CODEX_AUTH is the operator's Codex sign-in file, copied into the owner's model folder
// (mode 600) and removed again at teardown; LIVE_R26_CLI_AUTH_BASE is the model folder base.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

import { expect, test } from "@playwright/test";
import { pickCheapestActiveChatModel, type UatDiscoveredModel } from "../uat/model-tier.js";
import {
  NEW_HUB,
  R26,
  openConnection,
  r26ToolList,
  readDetail,
  setToolServerTools,
  signIn,
  connectionId,
  sortRuns
} from "./classifier-2984-r26-helpers.js";

function sql(query: string): string {
  const container = process.env.LIVE_R26_DB_CONTAINER;
  const database = process.env.LIVE_R26_DB;
  if (!container || !database) throw new Error("set LIVE_R26_DB_CONTAINER and LIVE_R26_DB");
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", database, "-Atc", query],
    { encoding: "utf8" }
  ).trim();
}

test("setup: owner, Codex sign-in as chat model, hub sorted and prepared", async ({ page }) => {
  test.setTimeout(900_000);
  await setToolServerTools(r26ToolList());

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();
  await page.getByLabel("Name").fill("Proof owner");
  await page.getByLabel("Email").fill(R26.ownerEmail);
  await page.getByLabel("Password").fill(R26.ownerPassword);
  await page.locator("form").getByRole("button", { name: "Create account" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  await expect(skipSetup.or(page.getByRole("navigation").first()).first()).toBeVisible({
    timeout: 30_000
  });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }

  const ownerId = sql(`select id from app.users where email = '${R26.ownerEmail}'`);
  const folder = `${required("LIVE_R26_CLI_AUTH_BASE")}/agents/${ownerId}/.codex`;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  copyFileSync(required("LIVE_R26_CODEX_AUTH"), `${folder}/auth.json`);

  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "openai-compatible" }
  });
  expect((await install.json()).installState).toBe("installed");
  const login = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "openai-compatible" }
  });
  expect((await login.json()).status).toBe("ready");

  let cheapest: UatDiscoveredModel | null = null;
  const deadline = Date.now() + 60_000;
  while (!cheapest && Date.now() < deadline) {
    const models = (
      (await (await page.request.get("/api/ai/models")).json()) as {
        models: readonly UatDiscoveredModel[];
      }
    ).models;
    try {
      cheapest = pickCheapestActiveChatModel(models);
    } catch {
      await page.waitForTimeout(2_000);
    }
  }
  console.log("R2.6b main chat model:", JSON.stringify(cheapest));
  if (cheapest) {
    for (const service of ["chat", "sorting"]) {
      const bound = await page.request.put(`/api/ai/services/${service}/binding`, {
        data: { binding: { kind: "model", modelId: cheapest.id } }
      });
      expect(bound.ok(), `${service} binding -> ${bound.status()}`).toBe(true);
    }
  }

  await page.goto("/settings?section=connections");
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabel("Name").fill(NEW_HUB);
  await page.getByLabel("URL").fill(`${R26.toolServer}/mcp`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to connections" })).toBeVisible({
    timeout: 60_000
  });
  await expect(
    page.locator(".intg-tools .pane__cardtitle").filter({ hasText: "Sends things out" })
  ).toHaveCount(1, { timeout: 300_000 });

  const panel = page.locator('[aria-label="Classifier"]');
  await panel
    .getByRole("checkbox", { name: "Let the classifier use this connection" })
    .locator("..")
    .click();
  await panel.getByRole("button", { name: "Turn on and prepare" }).click();
  await expect
    .poll(
      async () => (await readDetail(page, NEW_HUB)).classifierTools.map((t) => t.classifierState),
      {
        timeout: 300_000
      }
    )
    .not.toEqual(expect.arrayContaining(["preparing"]));
  await openConnection(page, NEW_HUB);
  console.log(
    "R2.6b tool states:",
    JSON.stringify(
      (await readDetail(page, NEW_HUB)).classifierTools.map((t) => [
        t.toolName,
        t.risk,
        t.classifierState
      ])
    )
  );
});

// A classifier that only chooses from a list (System One) cannot fill in free text, so the gate
// cannot run a tool that needs one. The stand-in door here takes a choice of door instead, with no
// hints, so Moss still sorts it as Sensitive.
test("setup 2: the stand-in door takes a choice of door, re-sorted and prepared", async ({
  page
}) => {
  test.setTimeout(900_000);
  await signIn(page);
  const id = await connectionId(page, NEW_HUB);
  const runsBefore = sortRuns(id).length;
  await setToolServerTools(
    r26ToolList().map((tool) =>
      tool.name === "unlock_door"
        ? {
            ...tool,
            inputSchema: {
              type: "object",
              properties: {
                door: {
                  type: "string",
                  enum: ["front", "back", "garage"],
                  description: "Which door."
                }
              }
            }
          }
        : tool
    )
  );
  await openConnection(page, NEW_HUB);
  await page.getByRole("button", { name: "Check for new tools" }).click();
  await expect
    .poll(() => sortRuns(id).slice(runsBefore).length, { timeout: 300_000, intervals: [3_000] })
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () => (await readDetail(page, NEW_HUB)).classifierTools.map((t) => t.classifierState),
      { timeout: 300_000 }
    )
    .not.toEqual(expect.arrayContaining(["preparing_again"]));
  console.log(
    "R2.6b tool states:",
    JSON.stringify(
      (await readDetail(page, NEW_HUB)).classifierTools.map((t) => [
        t.toolName,
        t.risk,
        t.classifierState
      ])
    )
  );
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}
