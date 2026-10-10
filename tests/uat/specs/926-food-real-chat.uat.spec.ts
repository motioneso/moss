import { execFileSync } from "node:child_process";
import { expect, test, type Page, type Response } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import {
  bringUpRealChatModel,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

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
//   - the destructive meals.delete declares "confirm_always", so it must always raise a card,
//     and no grant or promotion can ever skip it (policy.ts:36).
//
// This spec closes that gap the same way real-chat-onboarding.uat.spec.ts does: it runs only
// when the operator's own signed-in Codex CLI login has been copied into the stack (see
// tests/uat/real-chat-env.ts), drives a real model through the real chat drawer, approves the
// action on the real card, and then asserts the persisted record through the module's own page.
// It stays skipped on every default/CI run so the gate remains credential-free.
export const uatLevel = { level: "solo-admin", without: [] } as const;

// Both tests below drive the same real chat session, as the same seeded admin, against one
// shared instance, and both log and read the same user's meals. Run in parallel they see each
// other's rows and each other's turns, which showed up as one test finding no meal at all while
// the other was mid-turn. Serial is not a slowdown here: the run is dominated by model latency.
test.describe.configure({ mode: "serial" });

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);

const MEAL_TEXT = "oatmeal with blueberries";

async function openInstanceModules(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  await expect(page.getByRole("heading", { name: "Instance modules" })).toBeVisible();
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

// Sends one message through the real chat drawer and hands back the still-in-flight turn POST.
// That in-process waiter is the only thing that lets a confirm-gated tool execute at all
// (gateway.ts:364, :617), so a caller that needs to approve must NOT wait on it first.
//
// #1720: the promise is wrapped in an object on purpose. `await` flattens a promise returned from
// an async function, so `await sendMessage(...)` used to block until the turn ended — which for a
// confirm-gated tool means blocking until the 150s approval window expires, guaranteeing the
// later Approve arrives too late and gets a 409. The wrapper makes that mistake unwriteable.
async function sendMessage(page: Page, text: string): Promise<{ turnSettled: Promise<Response> }> {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: 300_000 }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  return { turnSettled };
}

// For a tool whose family is granted at install (food.meals.log / .correct / .reestimate declare
// selfOperationGrant "granted_at_install", so resolvePolicy returns "run" — policy.ts:29-57).
// The proof of correct behaviour here is that NO card is raised and the turn still settles: the
// module asked for standing permission up front rather than interrupting every meal.
async function sendAutoRun(page: Page, text: string): Promise<void> {
  const { turnSettled } = await sendMessage(page, text);
  const response = await turnSettled;
  expect(response.ok(), `the chat turn must settle for: ${text}`).toBe(true);
  // Count only cards still awaiting a decision — a resolved card from an earlier step stays
  // in the transcript, and counting those would make this assertion meaningless.
  expect(
    await page.locator(`${CARD}:has(button:text-is("Approve"))`).count(),
    `a granted-at-install Food tool must not interrupt with a confirmation card: ${text}`
  ).toBe(0);
}

// #1750 removed food.consent.grant, which was the only confirm-gated Food tool this spec could
// drive through a real chat turn. The remaining one, food.meals.delete, is still blocked by #1720
// (an Approve only counts while the turn's in-process waiter is alive, gateway.ts:497), so the
// approve-a-card helper that used to live here has no caller and was removed rather than left
// dead. Recover it from git history when #1720 lands and the delete half becomes provable.

// Setup shared by both tests below: stage the module, enable it through the real admin screen,
// and bring a real chat-capable model online.
async function prepareInstance(page: Page): Promise<void> {
  const projectName = requireUatProjectName();
  const baseURL = requireUatBaseURL();

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
    await signInUatAdmin(page);
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
    await bringUpRealChatModel(page);
  });
}

// The tools Food grants at install: they must execute inside a real chat turn WITHOUT raising a
// card. Logging does not depend on the AI-estimates switch — that switch only decides whether an
// estimate is attached — so this half stays provable while #1720 blocks every confirm-gated tool.
test("a real model logs and corrects meals through Food's granted-at-install tools (#926)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) — #926"
  );
  // A cold provider probe, async model discovery, and two real model round-trips run serially.
  test.setTimeout(900_000);

  const baseURL = requireUatBaseURL();
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

// The confirm-gated half. This was filed as #1720 — "the card reaches the browser only after the
// answering window closed" — but instrumenting both ends disproved that: the server emitted the
// card 8-17s in and the browser's stream handler logged receiving it 14ms later. The 150s was the
// spec's own doing, via `await sendMessage(...)` flattening the in-flight turn promise. See the
// comment on sendMessage. Product code was never at fault, so nothing outside this file changed.
test("a real model raises and resolves Food's confirm-gated tools (#926)", async ({ page }) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) — #926"
  );
  test.setTimeout(900_000);

  const baseURL = requireUatBaseURL();
  await prepareInstance(page);

  // Behaviour 3 (#1750) — there is no consent step any more. Installing Food is consent for
  // Food's normal functionality, so estimation is on by default and its switch lives in host
  // Settings. The Food page must therefore carry no consent wording and no toggle of its own.
  await test.step("the Food page asks for no consent and offers no estimation toggle", async () => {
    await page.goto(`${baseURL}/m/food`);
    // A regex match, not exact text: the failure this guards is any consent strip coming back,
    // in any wording, not one specific sentence.
    await expect(page.getByText(/consent/i)).toHaveCount(0);
    await expect(page.getByText(/Nutrition estimates are off/i)).toHaveCount(0);
  });

  // Behaviour 4 — the estimate the module attaches by default. It is the module's
  // own work, not model prose in the transcript: persisted on the record and rendered from it.
  // It can be computed after the turn ends, so reload until it lands.
  await test.step("a logged meal carries a real nutrition estimate, with no consent step", async () => {
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
    // Count first, and compare counts afterwards. The UAT database is shared and not reset, so
    // more than one oatmeal row can legitimately be present; asserting a single row is visible
    // fails on strict mode for a reason that has nothing to do with the deletion.
    const oatmealRows = page.locator(".fud-meal-row").filter({ hasText: /oatmeal/i });
    await page.goto(`${baseURL}/m/food`);
    // Auto-wait before counting: `count()` reads the DOM once with no retry, so counting straight
    // after goto() races the page's own load and reads zero.
    await expect(
      oatmealRows.first(),
      "the earlier steps should have left at least one oatmeal meal"
    ).toBeVisible({ timeout: 30_000 });
    const before = await oatmealRows.count();

    const { turnSettled } = await sendMessage(page, "Delete my oatmeal breakfast from today.");

    const card = page.locator(CARD).last();
    await expect(card, "a destructive Food tool must always raise a confirmation").toBeVisible({
      timeout: 120_000
    });
    const rejectedId = await card.getAttribute("data-action-request-id");
    await card.getByRole("button", { name: "Reject" }).click();
    await expectActionStatus(page, rejectedId as string, "rejected");
    expect((await turnSettled).ok(), "the chat turn must settle after Reject").toBe(true);

    await page.goto(`${baseURL}/m/food`);
    await expect(oatmealRows, "a rejected deletion must not remove the meal").toHaveCount(before, {
      timeout: 30_000
    });
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
