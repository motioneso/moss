import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #926 Food Phase 1 — the real-chat half of the Live-Path Gate.
//
// tests/live/food-926-uat.spec.ts already proves install/enable, nav placement, the read
// paths, two-actor privacy and disable/re-enable against the from-source dev instance. What
// it CANNOT prove is anything write-risk. Those tools execute ONLY inside a live chat turn:
// the gateway creates the pending action and then blocks on confirmations.awaitResolution
// (gateway.ts:364, :617), honouring a confirm only while that in-process waiter is alive
// (gateway.ts:490-499). The REST invoke route never registers a waiter (routes.ts:667-692), so
// there is no non-model path.
//
// Food splits its write tools deliberately, and this spec asserts BOTH halves:
//   - meals.log / .correct / .reestimate declare selfOperationGrant "granted_at_install", so
//     resolvePolicy returns "run" and they must NOT interrupt with a card (policy.ts:29-57).
//   - consent.grant and the destructive meals.delete declare "confirm_always", so they must
//     always raise a card — and for delete no grant or promotion can ever skip it
//     (policy.ts:36).
//
// This spec closes that gap the same way real-chat-onboarding.uat.spec.ts does: it runs only
// when the operator supplied a real Anthropic token (JARVIS_UAT_REAL_CHAT_TOKEN_FILE), drives
// a real model through the real chat drawer, approves the action on the real card, and then
// asserts the persisted record through the module's own page. It stays skipped on every
// default/CI run so the gate remains credential-free.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);

const MEAL_TEXT = "oatmeal with blueberries";
const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return projectName;
}

// solo-admin returns before the onboarding chunk, so login can land on the first-run wizard.
// Skip it only when shown, keeping this idempotent across the shared, non-reset DB.
async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function openInstanceModules(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
}

// Same non-interactive login the #1121 spec drives: the provisioner has already persisted the
// operator's OAuth token into the cli-auth volume, so begin settles to "ready" rather than
// handing back an authorization URL. Install must run first — token persistence and binary
// install are separate steps.
async function bringUpRealModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" }
  });
  expect(install.ok(), `provider-install -> ${install.status()}`).toBeTruthy();
  expect((await install.json()).installState).toBe("installed");

  const begin = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "anthropic" }
  });
  expect(begin.ok(), `provider-login/begin -> ${begin.status()}`).toBeTruthy();
  expect(
    (await begin.json()).status,
    "the pre-seeded token should authenticate the anthropic CLI non-interactively"
  ).toBe("ready");

  // Discovery runs asynchronously after login settles. Bounded exponential backoff, never a
  // fixed sleep.
  const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const body = (await (await page.request.get("/api/ai/models")).json()) as {
      models: readonly { status: string; capabilities: readonly string[] }[];
    };
    last = body.models;
    if (body.models.some((m) => m.status === "active" && m.capabilities.includes("chat"))) return;
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `no chat-capable active model after ${MODEL_DISCOVERY_DEADLINE_MS}ms: ${JSON.stringify(last)}`
  );
}

const CARD = '[role="region"][aria-label="Action request"]';

interface RecordedAction {
  readonly id: string;
  readonly toolName?: string;
  readonly status: string;
}

async function listActions(page: Page): Promise<readonly RecordedAction[]> {
  const response = await page.request.get("/api/ai/assistant-actions");
  expect(response.ok(), `assistant-actions -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { actions: readonly RecordedAction[] }).actions;
}

async function expectActionStatus(page: Page, id: string, want: string): Promise<void> {
  await expect
    .poll(async () => (await listActions(page)).find((a) => a.id === id)?.status, {
      timeout: 60_000,
      message: `action ${id} never reached "${want}" on the server`
    })
    .toBe(want);
}

// Sends one message through the real chat drawer and returns a promise for the turn POST, which
// stays in flight while the model works. That in-process waiter is the only thing that lets a
// confirm-gated tool execute at all (gateway.ts:364, :617).
async function sendMessage(page: Page, text: string) {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: 300_000 }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  return turnSettled;
}

// For a tool whose family is granted at install (food.meals.log / .correct / .reestimate declare
// selfOperationGrant "granted_at_install", so resolvePolicy returns "run" — policy.ts:29-57).
// The proof of correct behaviour here is that NO card is raised and the turn still settles: the
// module asked for standing permission up front rather than interrupting every meal.
async function sendAutoRun(page: Page, text: string): Promise<void> {
  const turnSettled = await sendMessage(page, text);
  const response = await turnSettled;
  expect(response.ok(), `the chat turn must settle for: ${text}`).toBe(true);
  // Count only cards still awaiting a decision — a resolved card from an earlier step stays
  // in the transcript, and counting those would make this assertion meaningless.
  expect(
    await page.locator(`${CARD}:has(button:text-is("Approve"))`).count(),
    `a granted-at-install Food tool must not interrupt with a confirmation card: ${text}`
  ).toBe(0);
}

// For a tool that must always ask (food.consent.grant and food.meals.delete declare
// selfOperationGrant "confirm_always"). Returns the recorded action-request id so the caller can
// tie its assertion to the exact row.
async function sendAndApprove(page: Page, text: string): Promise<string> {
  const sentAt = Date.now();
  const turnSettled = await sendMessage(page, text);

  // #926 diagnosis: an Approve is only honoured while the chat turn's in-process waiter is alive
  // (gateway.ts:497, 150s — claude-permission-hook.ts:19). When it is not, the resolve returns 409
  // and the row stays pending by design. Record the elapsed time and the server's actual answer so
  // a failure says WHICH of those happened instead of only "never reached confirmed".
  const resolveSeen = page.waitForResponse(
    (r) => /\/api\/chat\/action-requests\/[^/]+\/resolve/.test(r.url()),
    { timeout: 60_000 }
  );

  // Watch the SERVER for the pending row as well as the drawer for the card. If the row shows up
  // promptly but the card does not, the confirmation is being raised in time and the browser is
  // simply not being told — a very different defect from a slow model.
  // Wait on the SERVER's record first, then look at the drawer. Doing it in this order (rather
  // than polling in the background) is what distinguishes "the model was slow to ask" from "the
  // server asked promptly and the browser was never told in time".
  await expect
    .poll(async () => (await listActions(page)).some((a) => a.status === "pending"), {
      timeout: 120_000,
      intervals: [1_000],
      message: `the server never recorded a pending action for: ${text}`
    })
    .toBe(true);
  const rowAt = Date.now();

  const card = page.locator(CARD).last();
  const cardVisibleWhenRowAppeared = await card.isVisible();
  await expect(card, `the model did not raise an action request for: ${text}`).toBeVisible({
    timeout: 120_000
  });
  const actionRequestId = await card.getAttribute("data-action-request-id");
  expect(actionRequestId, "card must carry an action request id").toEqual(expect.any(String));

  const cardAt = Date.now();
  await card.getByRole("button", { name: "Approve" }).click();

  const resolveResponse = await resolveSeen;
  const clickedAt = Date.now();
  console.log(
    `[926] ${text}: server row after ${rowAt - sentAt}ms ` +
      `(card on screen by then: ${cardVisibleWhenRowAppeared}), card after ${cardAt - sentAt}ms, ` +
      `approve resolved ${resolveResponse.status()} after ${clickedAt - sentAt}ms ` +
      `(waiter window is 150000ms)`
  );
  expect(
    resolveResponse.status(),
    `Approve was refused: 409 means the chat turn's waiter was already gone ${clickedAt - sentAt}ms ` +
      `after the message was sent`
  ).toBe(204);
  // Assert the decision landed on the SERVER, not on the card. The card's label is derived from
  // a client-side mutation state, so a re-render of the transcript resets it to "Needs your
  // approval" even after a successful approve — checking the label makes this step flaky in one
  // direction and, worse, silently passable in the other.
  await expectActionStatus(page, actionRequestId as string, "confirmed");

  const response = await turnSettled;
  expect(response.ok(), "the chat turn must settle after Approve").toBe(true);
  return actionRequestId as string;
}

// Setup shared by both tests below: stage the module, enable it through the real admin screen,
// and bring a real chat-capable model online.
async function prepareInstance(page: Page): Promise<void> {
  const projectName = requireProjectName();
  const baseURL = requireBaseURL();

  await test.step("stage Food into the running instance and restart", async () => {
    execFileSync("pnpm", ["build:external:food"], { stdio: "inherit" });
    execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "cp",
        "external-modules/food",
        "jarv1s:/data/modules/food"
      ]),
      { stdio: "inherit" }
    );
    await restartUatStack(projectName, baseURL);
  });

  await test.step("enable Food through the real admin screen", async () => {
    await signIn(page);
    await openInstanceModules(page);
    const enableSwitch = page.getByRole("checkbox", { name: "Enable Food", exact: true });
    await expect(enableSwitch).toHaveCount(1);
    if (!(await enableSwitch.isChecked())) {
      await page.locator("label.jds-switch", { has: enableSwitch }).click();
    }
    await expect(enableSwitch).toBeChecked();
    await restartUatStack(projectName, baseURL);
    await page.reload();
  });

  await test.step("bring a real chat-capable model online", async () => {
    await bringUpRealModel(page);
  });
}

// The tools Food grants at install: they must execute inside a real chat turn WITHOUT raising a
// card. Logging does not depend on consent — consent only adds the AI estimate (meals.ts:202) —
// so this half stays provable while #1720 blocks every confirm-gated tool on the platform.
test("a real model logs and corrects meals through Food's granted-at-install tools (#926)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset) — #926"
  );
  // A cold provider probe, async model discovery, and two real model round-trips run serially.
  test.setTimeout(900_000);

  const baseURL = requireBaseURL();
  await prepareInstance(page);

  // Behaviour 1 — logging a meal.
  await test.step("logging a meal runs food.meals.log and the record renders", async () => {
    await sendAutoRun(page, `Log that I had ${MEAL_TEXT} for breakfast today.`);

    await page.goto(`${baseURL}/m/food`);
    const row = page.locator(".fud-meal-row").filter({ hasText: /oatmeal/i });
    await expect(row, "the logged meal must appear on the Food page").toBeVisible({
      timeout: 30_000
    });
  });

  // Behaviour 2 — correction. A second granted-at-install tool over the record the first one
  // created, which also proves the row is addressable after the fact.
  await test.step("correcting a meal runs food.meals.correct and the change persists", async () => {
    await sendAutoRun(page, "Change my oatmeal breakfast today to a large bowl instead.");

    await page.goto(`${baseURL}/m/food`);
    await expect(
      page.locator(".fud-meal-row").filter({ hasText: /large/i }),
      "the corrected wording must be persisted on the record"
    ).toBeVisible({ timeout: 30_000 });
  });

  // No card may have been raised: these two tools declare selfOperationGrant
  // "granted_at_install", so resolvePolicy returns "run" (policy.ts:29-57). A card here would
  // mean the grant is not being honoured.
  await test.step("neither granted-at-install tool interrupted with a card", async () => {
    await expect(page.locator(CARD)).toHaveCount(0);
    // And no action request exists for them either. "run" means the gateway executes without
    // ever creating one (policy.ts:29-57) — these calls are audited, not confirmed. Anything in
    // this list would mean a tool that should be silent asked the user instead.
    const foodActions = (await listActions(page)).filter((a) =>
      (a.toolName ?? "").startsWith("food.")
    );
    expect(
      foodActions,
      "a granted-at-install tool must not create a confirmation request"
    ).toHaveLength(0);
  });
});

// The confirm-gated half. Blocked by #1720: a confirm-gated tool's card only reaches the browser
// after the server's 150s answering window has already closed, so Approve returns 409 and the row
// stays pending. Reproduced seven times; the server writes and commits the pending row ~22s in and
// serves the actions endpoint in milliseconds throughout, so this is a delivery defect, not a Food
// defect. Un-fixme this once #1720 lands — the body below is correct and is the regression test.
test.fixme("a real model raises and resolves Food's confirm-gated tools (#926, blocked by #1720)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset) — #926"
  );
  test.setTimeout(900_000);

  const baseURL = requireBaseURL();
  await prepareInstance(page);

  // Behaviour 3 — consent. The Food page renders consent read-only until #1699 lands, so the
  // only way to grant it is the write-risk tool, which is exactly what this proves.
  await test.step("granting AI estimation consent runs food.consent.grant", async () => {
    await sendAndApprove(page, "Turn on AI nutrition estimates for my food log.");

    // Exact text: the banner's other state is "not granted", which a loose /granted/ match
    // would happily accept.
    await page.goto(`${baseURL}/m/food`);
    await expect(page.locator(".fud-consent")).toHaveText("AI estimation consent: granted");
  });

  // Behaviour 4 — the estimate the module attaches once consent is granted. It is the module's
  // own work, not model prose in the transcript: persisted on the record and rendered from it.
  // It can be computed after the turn ends, so reload until it lands.
  await test.step("a logged meal carries a real nutrition estimate once consent is granted", async () => {
    await sendAutoRun(page, `Log that I had ${MEAL_TEXT} for breakfast today.`);

    await page.goto(`${baseURL}/m/food`);
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.locator(".fud-meals").innerText();
        },
        { timeout: 120_000, message: "no nutrition estimate rendered on the logged meal" }
      )
      .toContain("Calories");
  });

  // The safety half. food.meals.delete is destructive, so resolvePolicy returns "confirm"
  // unconditionally (policy.ts:36) — no install grant and no user promotion can skip it.
  // Reject rather than approve: that proves the block actually holds, since the meal must
  // survive a refused deletion.
  await test.step("deleting a meal always asks, and rejecting it leaves the meal intact", async () => {
    const turnSettled = await sendMessage(page, "Delete my oatmeal breakfast from today.");

    const card = page.locator(CARD).last();
    await expect(card, "a destructive Food tool must always raise a confirmation").toBeVisible({
      timeout: 120_000
    });
    const rejectedId = await card.getAttribute("data-action-request-id");
    await card.getByRole("button", { name: "Reject" }).click();
    await expectActionStatus(page, rejectedId as string, "rejected");
    expect((await turnSettled).ok(), "the chat turn must settle after Reject").toBe(true);

    await page.goto(`${baseURL}/m/food`);
    await expect(
      page.locator(".fud-meal-row").filter({ hasText: /oatmeal/i }),
      "a rejected deletion must not remove the meal"
    ).toBeVisible({ timeout: 30_000 });
  });

  // Every Food call must leave an auditable row, and none may sit pending-but-applied.
  await test.step("every Food action is recorded and resolved", async () => {
    const foodActions = (await listActions(page)).filter((a) =>
      (a.toolName ?? "").startsWith("food.")
    );
    expect(foodActions.length, "Food calls must be recorded as actions").toBeGreaterThan(0);
    for (const action of foodActions) {
      expect(["confirmed", "rejected", "cancelled", "expired"]).toContain(action.status);
    }
    expect(
      foodActions.some((a) => a.toolName === "food.meals.delete" && a.status === "rejected"),
      "the refused deletion must be recorded as rejected"
    ).toBe(true);
  });
});
