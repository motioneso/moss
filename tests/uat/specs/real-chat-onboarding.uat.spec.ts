import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { pickCheapestActiveChatModel, type UatDiscoveredModel } from "../model-tier.js";

// #1121/#2732: the real-LLM half of runtime-context.uat.spec.ts's deferred assertions. That file
// `test.fixme`s every real chat reply because the DEFAULT harness seeds only a fake provider bound
// to module.news — no seed level can drive a turn to a model reply. This spec closes that gap for
// the ONE opt-in configuration where a real, instruction-following chat model IS reachable: the
// operator's own signed-in Codex CLI login, copied into the stack by the provisioner (tests/uat/
// real-chat-env.ts). It stays skipped for every default/CI run so the gate remains credential-free
// (Coordinator constraint 1).
export const uatLevel = { level: "solo-admin", without: [] } as const;

// #2732: the provisioner sets this ONLY after copying a real Codex login into the stack. Its
// presence is the authoritative "a real chat model can be reached THIS run" signal — absent on
// every default/CI run, so the whole spec skips rather than failing. run-uat.ts spawns Playwright
// with `...process.env` (tests/uat/run-uat.ts:92-96), so the var the provisioner set on the
// harness process reaches here.
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);

// #1121: bounded exponential backoff, never a fixed sleep (Coordinator constraint). Model discovery
// runs asynchronously after login settles, so the first /api/ai/models read can legitimately show no
// chat-capable row yet; we retry with growing gaps up to a hard deadline, then fail loudly.
const POLL_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Copied (not imported) from runtime-context.uat.spec.ts:31-46 — importing across spec files would
// also register that file's top-level test() calls here. This mirrors the harness's established
// signIn duplication (app-map-grounding.uat.spec.ts <-> runtime-context.uat.spec.ts share the same
// copy for the same reason). `solo-admin` returns before the onboarding chunk, so login lands on the
// first-run wizard; skip it only when shown, keeping this idempotent across the shared, non-reset DB.
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

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

test("real Codex login yields the cheapest chat-capable model and answers a turn (#1121, #2732)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) — #1121"
  );
  // Generous: a cold real provider probe + async model discovery + one real model round-trip all
  // happen serially below; the default per-test timeout would flake on a slow upstream.
  test.setTimeout(180_000);

  await signIn(page);

  // The CLI binary is NOT present on a fresh cli-tools volume even though the provisioner already
  // copied the host's Codex login into the cli-auth volume (tests/uat/real-chat-env.ts) — login
  // and binary install are separate steps (uat-real-chat-onboarding-cli-tools-missing). Drive the
  // same admin-gated install route the real onboarding UI calls (packages/settings/src/
  // onboarding-routes.ts §A.5.1) BEFORE provider-login/begin, or begin sees no binary and returns
  // "awaiting_token" regardless of the pre-copied login (#1121). "openai-compatible" is Codex's
  // provider kind (#2732) — Anthropic's token-based path is retired, and Gemini is blocked for
  // personal accounts (see issue #2732).
  const installBody = (await readJson(
    await page.request.post("/api/onboarding/provider-install", {
      data: { providerKind: "openai-compatible" }
    })
  )) as { installState?: string };
  expect(
    installBody.installState,
    `provider-install did not settle to installed (got "${installBody.installState}") (#1121)`
  ).toBe("installed");

  // Admin-gated onboarding login (packages/settings/src/onboarding-routes.ts:697-728). page.request
  // reuses the browser context's session cookie set by signIn, so this is authenticated. The CLI is
  // already authenticated by the pre-copied host Codex login in the cli-auth volume (tests/uat/
  // real-chat-env.ts), so this login settles non-interactively rather than returning an
  // awaiting_authorization URL.
  const beginBody = (await readJson(
    await page.request.post("/api/onboarding/provider-login/begin", {
      data: { providerKind: "openai-compatible" }
    })
  )) as { status?: string };
  expect(
    beginBody.status,
    `provider-login/begin did not settle to ready (got "${beginBody.status}") — the host's own ` +
      `Codex login should authenticate the CLI non-interactively (#1121)`
  ).toBe("ready");

  // Poll for discovery to land an eligible (active, chat-capable, economy-tier) model. Exponential
  // backoff to a hard deadline, no fixed sleep (Coordinator constraint).
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let lastModels: readonly UatDiscoveredModel[] = [];
  let cheapest: UatDiscoveredModel | undefined;
  while (Date.now() < deadline) {
    const body = (await readJson(await page.request.get("/api/ai/models"))) as {
      models: readonly UatDiscoveredModel[];
    };
    lastModels = body.models;
    try {
      cheapest = pickCheapestActiveChatModel(lastModels);
      break;
    } catch {
      // Discovery hasn't landed an eligible model yet; keep polling until the deadline.
    }
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  expect(
    cheapest,
    `no active, chat-capable, economy-tier model after ${POLL_DEADLINE_MS}ms; last ` +
      `/api/ai/models: ${JSON.stringify(lastModels)}`
  ).toBeDefined();

  // #2732: Ben's ruling is that every real-chat UAT turn runs through the account's cheapest
  // ("economy") model to preserve usage — never hardcode a model name or fall back to a pricier
  // tier. Admin must enable the override before a user's own override selection takes effect
  // (packages/ai/src/routes.ts PUT /api/admin/ai/chat-model-override, PUT
  // /api/ai/chat-model-override).
  await readJson(
    await page.request.put("/api/admin/ai/chat-model-override", { data: { enabled: true } })
  );
  await readJson(
    await page.request.put("/api/ai/chat-model-override", {
      data: { modelId: cheapest!.id }
    })
  );

  // Drive a real turn and assert a real reply. /api/chat/turn returns { reply, assistantMessageId }
  // synchronously (packages/chat/src/live-routes.ts:177-181). We assert only that a real,
  // model-generated reply came back — never the exact text (a real model is non-deterministic).
  const turnBody = (await readJson(
    await page.request.post("/api/chat/turn", {
      data: { text: "Reply with exactly the three words: real chat works." }
    })
  )) as { reply?: string };
  expect(typeof turnBody.reply, "chat turn returned no string reply").toBe("string");
  expect((turnBody.reply ?? "").trim().length, "chat turn reply was empty").toBeGreaterThan(0);
});
