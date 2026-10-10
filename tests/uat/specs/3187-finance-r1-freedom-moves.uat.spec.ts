import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { bringUpRealChatModel } from "./real-chat-signin.js";

// #3187: Finance R1 phase 3 (freedom steps, dollar limit, chat money moves, activity and undo),
// walked end to end on a real instance against the Plaid sandbox.
//
// No faked data. The bank comes through Plaid's own hosted sign-in page (sandbox user_good /
// pass_good), the sync pulls Plaid's sandbox transactions, and nothing in the browser is
// intercepted or rewritten. The Finance module is installed and enabled the same way an operator
// would (see finance-feed.uat.spec.ts).
//
// Needs Plaid SANDBOX keys. They are read from PLAID_SANDBOX_CLIENT_ID and PLAID_SANDBOX_SECRET,
// or from a two-line file (client id, then secret) named by PLAID_SANDBOX_KEYS_FILE. Without them
// the test skips; it never runs against production keys.
//
// Starting the bank link goes through Moss's chat with a real model (the host's Codex login, copied
// in by the harness), as a user would. The first budget amount is typed on the Budget screen.
export const uatLevel = { level: "admin+data", without: ["finance"] } as const;

const PROOF_DIR = process.env.FIN_3187_PROOF_DIR ?? "/tmp/fin-3187-proof";

function readSandboxKeys(): { clientId: string; secret: string } | null {
  const envId = process.env.PLAID_SANDBOX_CLIENT_ID;
  const envSecret = process.env.PLAID_SANDBOX_SECRET;
  if (envId && envSecret) return { clientId: envId, secret: envSecret };
  const file = process.env.PLAID_SANDBOX_KEYS_FILE;
  if (!file) return null;
  const [clientId, secret] = readFileSync(file, "utf8").trim().split("\n");
  return clientId && secret ? { clientId, secret } : null;
}

const keys = readSandboxKeys();

interface InvocationBody {
  invocation?: { status?: string; blockedReason?: string; result?: Record<string, unknown> };
}

async function invoke(
  page: Page,
  name: string,
  input: Record<string, unknown> = {}
): Promise<InvocationBody["invocation"]> {
  const response = await page.request.post(`/api/ai/assistant-tools/${name}/invoke`, {
    data: { input }
  });
  expect(response.ok(), `${name} -> ${response.status()} ${await response.text()}`).toBeTruthy();
  return ((await response.json()) as InvocationBody).invocation;
}

async function crop(target: Locator, name: string): Promise<void> {
  mkdirSync(PROOF_DIR, { recursive: true });
  await target.screenshot({ path: join(PROOF_DIR, `${name}.png`) });
}

// Money text such as "$1,234.50" to cents.
function cents(text: string): number {
  const match = text.replace(/,/g, "").match(/\$(-?\d+(?:\.\d+)?)/);
  if (!match?.[1]) throw new Error(`no amount in "${text}"`);
  return Math.round(Number(match[1]) * 100);
}

// Plaid's hosted sign-in page lives in an iframe. Sandbox bank: First Platypus. The user_transactions_dynamic login makes Plaid add new rows on later syncs, which the freedom-step check needs.
async function completeHostedLink(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const frame = page.frameLocator("iframe").first();
  await frame.getByText("Continue without phone number").click();
  await frame.getByPlaceholder(/search/i).fill("First Platypus");
  await frame.getByText("First Platypus Bank").first().click();
  await frame.getByRole("button", { name: "First Platypus Bank", exact: true }).first().click();
  await frame
    .locator("input[type=text],input:not([type])")
    .first()
    .fill("user_transactions_dynamic");
  await frame.locator("input[type=password]").first().fill("pass_good");
  await frame
    .getByRole("button", { name: /submit|continue/i })
    .first()
    .click();
  // Account list, then confirm, then the finish screen.
  for (let step = 0; step < 4; step += 1) {
    const next = frame.getByRole("button", { name: /^(continue|done|finish)/i }).first();
    try {
      await next.click({ timeout: 15_000 });
    } catch {
      break;
    }
  }
}

test.skip(!keys, "needs Plaid sandbox keys (PLAID_SANDBOX_CLIENT_ID and PLAID_SANDBOX_SECRET)");

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (testInfo.status === testInfo.expectedStatus || !projectName) return;
  try {
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--tail", "3000", "jarv1s"]),
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    console.log(
      logs
        .split("\n")
        .filter((line) => !line.includes('"msg":"incoming request"') && !line.includes("completed"))
        .join("\n")
    );
  } catch {
    // diagnostics only
  }
});

test("Finance phase 3: freedom step, dollar limit, chat moves, activity and undo", async ({
  page
}) => {
  test.setTimeout(900_000);
  if (!keys) return;

  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  // --- Install Finance, discover it on restart ---------------------------------------------
  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "cp",
      "external-modules/finance",
      "jarv1s:/data/modules/finance"
    ]),
    { stdio: "inherit" }
  );
  await restartUatStack(projectName, baseURL);

  // --- Sign in -----------------------------------------------------------------------------
  await page.goto(baseURL);
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
  await bringUpRealChatModel(page);

  // --- Enable Finance and enter the bank keys through the admin screen ---------------------
  await userMenu.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  const enableSwitch = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await expect(enableSwitch).not.toBeChecked();
  await page.locator("label.jds-switch", { has: enableSwitch }).click();
  await expect(enableSwitch).toBeChecked();

  await page.getByLabel("Plaid client id", { exact: true }).fill(keys.clientId);
  await page
    .getByLabel("Plaid client id", { exact: true })
    .locator("xpath=following-sibling::button[1]")
    .click();
  await page.getByLabel("Plaid secret", { exact: true }).fill(keys.secret);
  await page
    .getByLabel("Plaid secret", { exact: true })
    .locator("xpath=following-sibling::button[1]")
    .click();
  await expect(page.getByPlaceholder("•••••••• (stored)")).toHaveCount(2);

  // The instance's Plaid environment has no screen yet; set it to sandbox in the instance's own
  // database. This is a setting, not test data.
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-c",
      `INSERT INTO app.module_kv (module_id, namespace, scope, key, value)
       VALUES ('finance', 'finance.settings', 'instance', 'plaid', '{"environment":"sandbox"}')
       ON CONFLICT (module_id, namespace, key) WHERE scope = 'instance'
       DO UPDATE SET value = EXCLUDED.value`
    ]),
    { stdio: "inherit" }
  );

  // The module's worker registers its queues at boot.
  await restartUatStack(projectName, baseURL);
  await page.reload();

  // --- Connect a bank through Plaid's hosted page ------------------------------------------
  // The real path: Getting started offers "Connect a bank", which puts the request in Moss's chat.
  // Moss asks to start the bank link, the user approves, and Moss answers with Plaid's link.
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await page.getByRole("button", { name: "Connect a bank", exact: true }).click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toHaveValue(/Connect my bank account/);
  await composer.press("Enter");
  const approve = page
    .locator('[role="region"][aria-label="Action request"]')
    .getByRole("button", { name: "Approve" })
    .last();
  // A real model can ask a question or announce an action and end its turn. Nudge it, up to three
  // times, to start the link; the bank itself is chosen later on Plaid's own page.
  for (let nudge = 0; nudge < 3; nudge += 1) {
    const shown = await expect(approve)
      .toBeVisible({ timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) break;
    await composer.fill(
      "Use your bank connection tool now to start the link. I will pick the bank on Plaid's page."
    );
    await composer.press("Enter");
  }
  await expect(approve).toBeVisible({ timeout: 120_000 });
  await approve.click();
  const hostedLink = page.locator('a[href*="plaid.com/"]').last();
  await expect(hostedLink).toBeVisible({ timeout: 180_000 });
  const hostedLinkUrl = (await hostedLink.getAttribute("href"))!;

  const linkPage = await page.context().newPage();
  await completeHostedLink(linkPage, hostedLinkUrl);
  await linkPage.close();

  // Finish the connection and pull accounts and transactions with the same queue runs the screens
  // use. Plaid's sandbox needs a moment before transactions are ready, so keep going until some
  // arrive.
  const runQueue = async (queue: string, jobKind: string) => {
    const response = await page.request.post(`/api/modules/finance/queues/${queue}/run`, {
      data: { jobKind }
    });
    expect(response.status(), `${queue} queued`).toBe(202);
  };
  await expect(async () => {
    await runQueue("finance.connect-poll", "finance.connect-poll-now");
    await page.waitForTimeout(4_000);
    await runQueue("finance.sync-run", "finance.sync-run-now");
    await page.waitForTimeout(6_000);
    const found = await invoke(page, "finance.setup.status");
    expect(found?.result?.hasBank).toBe(true);
    let synced = 0;
    for (let back = 0; back < 4; back += 1) {
      const when = new Date();
      when.setUTCDate(1);
      when.setUTCMonth(when.getUTCMonth() - back);
      const month = when.toISOString().slice(0, 7);
      const feed = await invoke(page, "finance.transactions.query", { month });
      const rows = (feed?.result as { transactions?: unknown[] } | undefined)?.transactions;
      synced += rows?.length ?? 0;
    }
    expect(synced, "transactions have arrived from the sandbox").toBeGreaterThan(5);
  }).toPass({ timeout: 240_000, intervals: [5_000] });

  // --- Settings: step 2 and a $100 limit ----------------------------------------------------
  const settings = page.locator('section[aria-label="Finance settings"]');
  const views = page.locator('[aria-label="Finance views"]');
  const openFinance = async () => {
    await page.goto(baseURL);
    await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
    await expect(views).toBeVisible({ timeout: 30_000 });
  };
  const openSettings = async () => {
    await openFinance();
    await page.getByRole("link", { name: "Finance settings" }).click();
    await expect(settings).toBeVisible({ timeout: 30_000 });
  };

  await openSettings();
  await settings
    .getByRole("radio", { name: /Handle routine, ask about new/ })
    .click({ force: true });
  const limitBox = settings.getByLabel("Moss can move up to, per move");
  await limitBox.fill("100");
  await limitBox.press("Enter");
  // Both choices must survive a reload, so they came back from the server.
  await expect(async () => {
    await openSettings();
    await expect(
      settings.getByRole("radio", { name: /Handle routine, ask about new/ })
    ).toBeChecked({ timeout: 5_000 });
    await expect(settings.getByLabel("Moss can move up to, per move")).toHaveValue("$100", {
      timeout: 5_000
    });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
  await crop(settings, "settings-step-2-limit-100");

  // --- Budget: give Groceries $500 so there is something to move ----------------------------
  const budget = page.locator('section[aria-label="Budget"]');
  const openBudget = async () => {
    await openFinance();
    await views.getByText("Budget", { exact: true }).click();
    await expect(budget).toBeVisible({ timeout: 30_000 });
  };
  const assignedBox = (name: string) =>
    budget.getByLabel(`Assigned to ${name}`).locator("visible=true").first();
  const readAssigned = async (name: string): Promise<number> => {
    await openBudget();
    return cents(await assignedBox(name).inputValue());
  };
  await openBudget();
  const groceriesBox = assignedBox("Groceries");
  await groceriesBox.click();
  await groceriesBox.press("Control+a");
  await groceriesBox.pressSequentially("500");
  await groceriesBox.press("Enter");
  await expect(async () => {
    expect(await readAssigned("Groceries")).toBe(50_000);
  }).toPass({ timeout: 90_000, intervals: [3_000] });
  const fuelBefore = await readAssigned("Fuel");

  // --- Chat: a $50 move under the limit still asks, then runs on approval -------------------
  // ACP chats are marked as holding outside content at launch, so every write in chat asks,
  // whatever the module's freedom step and limit (#3338). Under the limit, Approve runs the move.
  const card = page.locator('[role="region"][aria-label="Action request"]');
  const ask = async (text: string) => {
    if (!(await composer.isVisible())) {
      await page.getByRole("button", { name: "Chat with Moss" }).click();
    }
    await composer.fill(text);
    await composer.press("Enter");
    // Reloading the page mid-turn drops the turn, so stay put until Moss stops thinking or asks.
    const thinking = page.getByText("Thinking", { exact: true }).last();
    await thinking.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await expect(async () => {
      const busy = await thinking.isVisible();
      const asking = await card.getByRole("button", { name: "Approve" }).last().isVisible();
      expect(busy && !asking, "Moss is still working").toBe(false);
    }).toPass({ timeout: 240_000, intervals: [2_000] });
  };
  await ask(
    "Move $50 from Groceries to Fuel for this month's budget. Use the budget move tool and tell me the result."
  );
  const approveSmallMove = card.getByRole("button", { name: "Approve" }).last();
  await expect(approveSmallMove).toBeVisible({ timeout: 240_000 });
  await crop(card.last(), "approval-card-50");
  await approveSmallMove.click();
  await expect(async () => {
    expect(await readAssigned("Groceries")).toBe(45_000);
    expect(await readAssigned("Fuel")).toBe(fuelBefore + 5_000);
  }).toPass({ timeout: 240_000, intervals: [5_000] });

  // --- Settings activity list shows the move, and Undo puts it back -------------------------
  await openSettings();
  const moveRow = settings
    .locator(".fnm-switch-row", { hasText: /Moved \$50(\.00)? from Groceries to Fuel/ })
    .locator("visible=true")
    .first();
  await expect(moveRow).toBeVisible({ timeout: 60_000 });
  await expect(moveRow).toContainText("Moss");
  await crop(settings, "settings-activity-after-move");
  await moveRow.getByRole("button", { name: "Undo" }).click();
  await expect(moveRow).toContainText("Undone", { timeout: 60_000 });
  await crop(settings, "settings-activity-after-undo");
  expect(await readAssigned("Groceries"), "Undo restored Groceries").toBe(50_000);
  expect(await readAssigned("Fuel"), "Undo restored Fuel").toBe(fuelBefore);

  // --- Chat: a $250 move is over the limit; Reject leaves the money where it was -------------
  await openFinance();
  await ask(
    "Move $250 from Groceries to Fuel for this month's budget. Use the budget move tool now."
  );
  const approveMove = card.getByRole("button", { name: "Approve" }).last();
  await expect(approveMove).toBeVisible({ timeout: 240_000 });
  await crop(card.last(), "approval-card-250");
  await card.getByRole("button", { name: "Reject" }).last().click();
  expect(await readAssigned("Groceries"), "nothing moved without approval").toBe(50_000);

  // --- Step 1, then a sync: new rows land in Needs a look -----------------------------------
  await openSettings();
  await settings.getByRole("radio", { name: /Ask about everything/ }).click({ force: true });
  await expect(async () => {
    await openSettings();
    await expect(settings.getByRole("radio", { name: /Ask about everything/ })).toBeChecked({
      timeout: 5_000
    });
  }).toPass({ timeout: 60_000, intervals: [3_000] });

  const transactions = page.locator('section[aria-label="Transactions"]');
  const needsLookTab = transactions.getByText(/^Needs a look \(\d+\)$/);
  const needsLookCount = async (): Promise<number> => {
    await openFinance();
    await views.getByText("Transactions", { exact: true }).click();
    await expect(needsLookTab).toBeVisible({ timeout: 30_000 });
    return Number((await needsLookTab.innerText()).match(/\((\d+)\)/)![1]);
  };
  const before = await needsLookCount();
  await expect(async () => {
    await runQueue("finance.sync-run", "finance.sync-run-now");
    await page.waitForTimeout(8_000);
    expect(await needsLookCount(), "new rows arrived under step 1").toBeGreaterThan(before);
  }).toPass({ timeout: 240_000, intervals: [5_000] });
  await needsLookTab.click();
  await crop(transactions, "needs-a-look-after-step-1-sync");
});
