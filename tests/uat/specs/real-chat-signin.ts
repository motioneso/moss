// tests/uat/specs/real-chat-signin.ts
//
// #2732 P1-2: one shared sign-in + economy-model setup for every real-chat spec, so a provider
// migration only ever needs to happen here. A plain module, not a spec — importing a spec file
// directly would also register its top-level test() calls (the same reason the specs used to
// hand-copy this logic instead of importing one another).
//
// Every real-chat spec signs in with the provider JARVIS_UAT_REAL_CHAT_PROVIDER selects
// (real-chat-env.ts). Codex, the default, uses the operator's own login, already copied into the
// stack by the provisioner. Claude (#3361) signs in through Moss here, with the operator
// approving a one-time link (claude-signin-handoff.ts). Either way the spec then discovers and
// binds the cheapest ("economy" tier) chat-capable model Ben's ruling requires — never a
// hardcoded model name, and never a silent widen to a pricier tier when none is found.

import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { pickCheapestActiveChatModel, type UatDiscoveredModel } from "../model-tier.js";
import { uatRealChatProvider, uatRealChatProviderKind } from "../real-chat-env.js";
import {
  claudeSignInPaths,
  claudeSignInWaitMs,
  signInClaudeThroughMoss
} from "../claude-signin-handoff.js";

/** The selected provider's kind: "openai-compatible" for Codex, "anthropic" for Claude. */
export const REAL_CHAT_PROVIDER_KIND = uatRealChatProviderKind();

/** Time the Claude sign-in adds on top of a spec's own budget: the code wait plus Moss's settle. */
const CLAUDE_SIGNIN_EXTRA_MS = 5 * 60_000;

export const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

export function requireUatBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

export function requireUatProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return projectName;
}

export async function readUatJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

/**
 * solo-admin (and admin+data) return before the onboarding chunk, so login can land on the
 * first-run wizard. Skip it only when shown, keeping this idempotent across the shared,
 * non-reset DB.
 */
export async function signInUatAdmin(page: Page): Promise<void> {
  await page.goto(requireUatBaseURL());
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
}

/**
 * Installs the selected CLI and drives its admin-gated login. Codex is already authenticated by
 * the operator's own login the provisioner copied into the cli-auth volume (real-chat-env.ts),
 * so it settles to "ready" non-interactively. Claude waits for the operator to approve a
 * one-time link, so the running test's timeout grows by that wait first.
 */
export async function bringUpRealChatProvider(page: Page): Promise<void> {
  const install = (await readUatJson(
    await page.request.post("/api/onboarding/provider-install", {
      data: { providerKind: REAL_CHAT_PROVIDER_KIND }
    })
  )) as { installState?: string };
  expect(
    install.installState,
    `provider-install did not settle to installed (got "${install.installState}")`
  ).toBe("installed");

  if (uatRealChatProvider() === "claude") {
    const codeWaitMs = claudeSignInWaitMs();
    test.info().setTimeout(test.info().timeout + codeWaitMs + CLAUDE_SIGNIN_EXTRA_MS);
    await signInClaudeThroughMoss(
      {
        post: async (path, data) => readUatJson(await page.request.post(path, { data }))
      },
      {
        paths: claudeSignInPaths(requireUatProjectName()),
        codeWaitMs,
        sleep: (ms) => page.waitForTimeout(ms)
      }
    );
    return;
  }

  const begin = (await readUatJson(
    await page.request.post("/api/onboarding/provider-login/begin", {
      data: { providerKind: REAL_CHAT_PROVIDER_KIND }
    })
  )) as { status?: string };
  expect(
    begin.status,
    `provider-login/begin did not settle to ready (got "${begin.status}") — the host's own ` +
      "Codex login should authenticate the CLI non-interactively"
  ).toBe("ready");
}

/**
 * Polls GET /api/ai/models with bounded exponential backoff (never a fixed sleep) until
 * pickCheapestActiveChatModel finds an eligible model, or throws once `deadlineMs` passes.
 * Discovery runs asynchronously after login settles, so the first read can legitimately show no
 * chat-capable row yet.
 */
export async function discoverCheapestChatModel(
  page: Page,
  deadlineMs = MODEL_DISCOVERY_DEADLINE_MS
): Promise<UatDiscoveredModel> {
  const deadline = Date.now() + deadlineMs;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let lastModels: readonly UatDiscoveredModel[] = [];
  while (Date.now() < deadline) {
    const body = (await readUatJson(await page.request.get("/api/ai/models"))) as {
      models: readonly UatDiscoveredModel[];
    };
    lastModels = body.models;
    try {
      return pickCheapestActiveChatModel(lastModels);
    } catch {
      // Discovery hasn't landed an eligible model yet; keep polling until the deadline.
    }
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `no active, chat-capable, economy-tier model after ${deadlineMs}ms; last /api/ai/models: ` +
      JSON.stringify(lastModels)
  );
}

/**
 * Ben's ruling: every real-chat UAT turn runs through the account's cheapest ("economy") model
 * to preserve usage — never hardcode a model name or fall back to a pricier tier. Admin must
 * enable the override before a user's own selection takes effect (packages/ai/src/routes.ts PUT
 * /api/admin/ai/chat-model-override, PUT /api/ai/chat-model-override).
 */
export async function selectChatModelOverride(
  page: Page,
  model: UatDiscoveredModel
): Promise<void> {
  await readUatJson(
    await page.request.put("/api/admin/ai/chat-model-override", { data: { enabled: true } })
  );
  await readUatJson(
    await page.request.put("/api/ai/chat-model-override", { data: { modelId: model.id } })
  );
}

/**
 * The full setup real turns run against: install + log in the selected CLI, discover the cheapest
 * eligible model, and bind it as the account's chat override. Returns the model so a spec can
 * assert against its id.
 */
export async function bringUpRealChatModel(
  page: Page,
  deadlineMs = MODEL_DISCOVERY_DEADLINE_MS
): Promise<UatDiscoveredModel> {
  await bringUpRealChatProvider(page);
  const cheapest = await discoverCheapestChatModel(page, deadlineMs);
  await selectChatModelOverride(page, cheapest);
  return cheapest;
}
