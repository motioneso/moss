// Live-Path Gate for #2984 R2.6: the connection page and its classifier, end to end.
//
// Runs on current main, from source, against the scratch database that
// classifier-2984-r26-before-upgrade-uat.spec.ts filled on the old code. Real API, real worker,
// real default chat model through the operator's Codex sign-in, and the stand-in tool server.
// Nothing is intercepted. The tests run in order and each one builds on the last.
//
// Run with the variables in classifier-2984-r26-before-upgrade-uat.spec.ts, plus
//   LIVE_R26_WORKER_LOG=<the worker's log file>
// and copy the operator's Codex sign-in into the owner's model folder before test 2.
import { expect, test, type Page } from "@playwright/test";
import { pickCheapestActiveChatModel, type UatDiscoveredModel } from "../uat/model-tier.js";
import {
  NEW_HUB,
  OLD_HUB,
  R26,
  connectionId,
  openConnection,
  r26ToolList,
  readDetail,
  setToolServerTools,
  shootBoth,
  signIn,
  sortOf,
  sortRuns
} from "./classifier-2984-r26-helpers.js";

test.describe.configure({ mode: "serial" });

const CLASSIFIER = '[aria-label="Classifier"]';

const HUB_STATUS_V2 = "Report whether the hub is online and its firmware version.";
const DEVICES_V2 = "List each device on the hub with its room, model and battery level.";

/** The tool list with the descriptions changed so far in this run. */
function changedTools(descriptions: Readonly<Record<string, string>>) {
  return r26ToolList().map((tool) =>
    descriptions[tool.name] ? { ...tool, description: descriptions[tool.name]! } : tool
  );
}

async function turnClassifierOn(page: Page): Promise<void> {
  const panel = page.locator(CLASSIFIER);
  // The switch's checkbox is visually hidden; the user clicks its styled track.
  await panel
    .getByRole("checkbox", { name: "Let the classifier use this connection" })
    .locator("..")
    .click();
  await panel.getByRole("button", { name: "Turn on and prepare" }).click();
}

/**
 * Adds the Codex sign-in and binds its cheapest model to chat and sorting. When the sign-in offers
 * no economy-tier model, nothing is bound and the default model the sign-in added does the work;
 * the run log says which, for the PR's disclosure.
 */
async function bringUpCheapestModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "openai-compatible" }
  });
  expect((await install.json()).installState).toBe("installed");
  const login = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "openai-compatible" }
  });
  expect((await login.json()).status).toBe("ready");
  let models: readonly UatDiscoveredModel[] = [];
  let cheapest: UatDiscoveredModel | null = null;
  const deadline = Date.now() + 60_000;
  while (!cheapest && Date.now() < deadline) {
    models = (
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
  if (!cheapest) {
    console.log(
      "R2.6 model: no economy-tier model on this sign-in; using its default model. Found:",
      JSON.stringify(models.map(({ id, status, tier }) => ({ id, status, tier })))
    );
    return;
  }
  for (const service of ["chat", "sorting"]) {
    const bound = await page.request.put(`/api/ai/services/${service}/binding`, {
      data: { binding: { kind: "model", modelId: cheapest.id } }
    });
    expect(bound.ok(), `${service} binding -> ${bound.status()}`).toBe(true);
  }
  console.log("R2.6 model:", JSON.stringify(cheapest));
}

test("1. the upgraded connection waits on a model, and says so", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const id = await connectionId(page, OLD_HUB);
  console.log("R2.6 old connection id after upgrade:", id);

  const detail = await readDetail(page, OLD_HUB);
  expect(detail.classifierTools).toHaveLength(r26ToolList().length);
  for (const tool of detail.classifierTools) {
    expect(tool, tool.toolName).toMatchObject({ status: "failed", failure: "no_model" });
  }
  expect(sortRuns(id).at(-1)).toMatchObject({ status: "no_model" });

  await openConnection(page, OLD_HUB);
  await turnClassifierOn(page);
  const panel = page.locator(CLASSIFIER);
  await expect(panel.getByText("Couldn't prepare", { exact: true })).toBeVisible({
    timeout: 60_000
  });
  await expect(panel.getByText(/You don't have a default chat model/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
  await shootBoth(page, "r26-02-old-hub-no-model");
});

test("2. adding a model sorts and prepares the old connection with no click", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  const id = await connectionId(page, OLD_HUB);
  const runsBefore = sortRuns(id).length;
  await bringUpCheapestModel(page);

  // Reopen the page. No Try again, no reconnect, no edit.
  await openConnection(page, OLD_HUB);
  const panel = page.locator(CLASSIFIER);
  await expect(panel.getByText("Ready", { exact: true })).toBeVisible({ timeout: 420_000 });
  const detail = await readDetail(page, OLD_HUB);
  expect(detail.id).toBe(id);
  for (const tool of detail.classifierTools) {
    expect(tool, tool.toolName).toMatchObject({ status: "current", classifierState: "ready" });
  }
  const runs = sortRuns(id).slice(runsBefore);
  console.log("R2.6 old hub sorts after the model was added:", JSON.stringify(runs));
  expect(runs.some((run) => run.op === "model_ready" && (run.calls ?? 0) >= 1)).toBe(true);
  await shootBoth(page, "r26-03-old-hub-ready");
});

test("3. a new connection starts with every tool on and sorts with the classifier off", async ({
  page
}) => {
  test.setTimeout(600_000);
  await signIn(page);
  await page.goto("/settings?section=connections");
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabel("Name").fill(NEW_HUB);
  await page.getByLabel("URL").fill(`${R26.toolServer}/mcp`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to connections" })).toBeVisible({
    timeout: 60_000
  });

  const total = r26ToolList().length;
  await expect(page.getByText(`${total} of ${total} on`, { exact: true })).toBeVisible();
  const titles = page.locator(".intg-tools .pane__cardtitle");
  await expect(titles.filter({ hasText: "Sends things out" })).toHaveCount(1, {
    timeout: 300_000
  });
  await expect(page.getByText("Not sorted yet", { exact: true })).toHaveCount(0, {
    timeout: 60_000
  });

  const detail = await readDetail(page, NEW_HUB);
  expect(detail.classifierEnabled).toBe(false);
  expect(detail.mutedTools).toEqual([]);
  for (const tool of detail.classifierTools) {
    expect(tool, tool.toolName).toMatchObject({ status: "current", sortMethod: "model" });
  }
  console.log(
    "R2.6 new hub sorts:",
    JSON.stringify(detail.classifierTools.map((t) => [t.toolName, t.risk, t.asksFirst]))
  );
  const runs = sortRuns(detail.id);
  console.log("R2.6 new hub sort runs:", JSON.stringify(runs));
  expect(runs.filter((run) => (run.calls ?? 0) > 0)).toEqual([
    expect.objectContaining({ calls: 1, written: total })
  ]);
  await shootBoth(page, "r26-04-new-hub-sorted");
});

test("4. a changed tool re-sorts with one call, and the sorting line shows", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  const id = await connectionId(page, NEW_HUB);
  const runsBefore = sortRuns(id).length;
  await setToolServerTools(changedTools({ get_hub_status: HUB_STATUS_V2 }));

  await openConnection(page, NEW_HUB);
  await page.getByRole("button", { name: "Check for new tools" }).click();
  await expect
    .poll(
      () =>
        sortRuns(id)
          .slice(runsBefore)
          .filter((run) => (run.calls ?? 0) > 0),
      {
        timeout: 300_000,
        intervals: [3_000]
      }
    )
    .toEqual([expect.objectContaining({ calls: 1, written: 1 })]);

  await page.reload();
  const rail = page.getByRole("complementary", { name: "Connection" });
  await expect(rail.getByText(/Sorted by what they do on/)).toBeVisible({ timeout: 60_000 });
  await expect(rail.getByText(/read each tool's name, description and inputs/)).toBeVisible();
  await shootBoth(page, "r26-05-sorting-line");
});

test("5. turning the classifier on prepares with no further clicks", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  await openConnection(page, NEW_HUB);
  await turnClassifierOn(page);
  const panel = page.locator(CLASSIFIER);
  await expect(panel.getByText("Ready", { exact: true })).toBeVisible({ timeout: 420_000 });
  const detail = await readDetail(page, NEW_HUB);
  const states = detail.classifierTools.map((tool) => tool.classifierState);
  console.log("R2.6 new hub classifier states:", JSON.stringify(states));
  expect(states.every((state) => state === "ready")).toBe(true);
  await shootBoth(page, "r26-06-new-hub-ready");
});

test("6. a failure that reached the provider waits for Try again", async ({ page }) => {
  test.setTimeout(900_000);
  await signIn(page);
  const id = await connectionId(page, NEW_HUB);
  const runsBefore = sortRuns(id).length;

  // Disclosed setup: a model the provider does not have, added through the app's own model route
  // and chosen as the owner's chat model, so the sort call reaches the provider and is refused.
  const providerConfigId = (
    (await (await page.request.get("/api/ai/models")).json()) as {
      models: readonly { providerConfigId: string }[];
    }
  ).models[0]!.providerConfigId;
  const created = await page.request.post("/api/ai/models", {
    data: {
      providerConfigId,
      providerModelId: "r26-no-such-model",
      displayName: "Proof model the provider refuses",
      capabilities: ["chat", "json"],
      allowUserOverride: true
    }
  });
  expect(created.status()).toBe(201);
  const refusedModelId = ((await created.json()) as { model: { id: string } }).model.id;
  const overrideOn = await page.request.put("/api/admin/ai/chat-model-override", {
    data: { enabled: true }
  });
  expect(overrideOn.ok(), `admin override -> ${overrideOn.status()}`).toBe(true);
  const chosen = await page.request.put("/api/ai/chat-model-override", {
    data: { modelId: refusedModelId }
  });
  expect(chosen.ok(), `chat override -> ${chosen.status()}`).toBe(true);
  try {
    await setToolServerTools(
      changedTools({ get_hub_status: HUB_STATUS_V2, list_devices: DEVICES_V2 })
    );
    await openConnection(page, NEW_HUB);
    await page.getByRole("button", { name: "Check for new tools" }).click();
    await expect
      .poll(async () => sortOf(await readDetail(page, NEW_HUB), "list_devices").status, {
        timeout: 420_000,
        intervals: [3_000]
      })
      .toBe("failed");
  } finally {
    // The owner's chat model goes back to the default before the no-retry check.
    const cleared = await page.request.put("/api/ai/chat-model-override", {
      data: { modelId: null }
    });
    expect(cleared.ok(), `clear override -> ${cleared.status()}`).toBe(true);
    const overrideOff = await page.request.put("/api/admin/ai/chat-model-override", {
      data: { enabled: false }
    });
    expect(overrideOff.ok(), `admin override off -> ${overrideOff.status()}`).toBe(true);
    const removed = await page.request.delete(`/api/ai/models/${refusedModelId}`);
    expect(removed.ok(), `remove refused model -> ${removed.status()}`).toBe(true);
  }
  const failedSort = sortOf(await readDetail(page, NEW_HUB), "list_devices");
  console.log("R2.6 provider failure:", JSON.stringify(failedSort));
  expect(failedSort.failure).toBe("error");
  console.log("R2.6 sort runs during the failure:", JSON.stringify(sortRuns(id).slice(runsBefore)));

  // A working model is back. Reopening the page and waiting must not retry on its own.
  const runsAfterFailure = sortRuns(id).length;
  await openConnection(page, NEW_HUB);
  const rail = page.getByRole("complementary", { name: "Connection" });
  const retry = page.getByRole("button", { name: "Try again" }).first();
  await expect(retry).toBeVisible({ timeout: 60_000 });
  await shootBoth(page, "r26-07-provider-failure");
  await page.waitForTimeout(60_000);
  await page.reload();
  await expect(retry).toBeVisible({ timeout: 60_000 });
  expect(sortRuns(id).length).toBe(runsAfterFailure);
  expect(sortOf(await readDetail(page, NEW_HUB), "list_devices")).toMatchObject({
    status: "failed",
    failure: "error"
  });

  await retry.click();
  await expect
    .poll(async () => sortOf(await readDetail(page, NEW_HUB), "list_devices").status, {
      timeout: 420_000,
      intervals: [3_000]
    })
    .toBe("current");
  await expect(page.locator(CLASSIFIER).getByText("Ready", { exact: true })).toBeVisible({
    timeout: 420_000
  });
  await expect(rail.getByRole("button", { name: "Try again" })).toHaveCount(0);
  console.log(
    "R2.6 sort runs after Try again:",
    JSON.stringify(sortRuns(id).slice(runsAfterFailure))
  );
  await shootBoth(page, "r26-08-after-try-again");
});
