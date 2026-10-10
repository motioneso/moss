// Live-Path Gate for #2162 — connecting Moss to real external services through the real UI.
// Runs against a REAL running instance: real API, real Postgres with RLS, and two REAL
// services: a Home Assistant MCP server and a Radarr install (OpenAPI, pasted spec).
// Nothing is mocked. See docs/DEVELOPMENT_STANDARDS.md.
//
// On a disposable install (provisions its own stack and real model, then tears it down):
//   JARVIS_UAT_CLAIMED_WEB_PORT=<devports claim> \
//   LIVE_HA_MCP_URL=... LIVE_HA_TOKEN=... \
//   LIVE_RADARR_URL=... LIVE_RADARR_KEY=... LIVE_RADARR_SPEC_FILE=... \
//     pnpm test:uat:2162-live [playwright args, e.g. --grep OpenAPI]
//
// Against an already running instance with a configured chat model (traces record typed
// credentials, so keep them off):
//   LIVE_BASE_URL=... LIVE_OWNER_EMAIL=... LIVE_OWNER_PASSWORD=... <service vars as above> \
//     npx playwright test --config playwright.live.config.ts --trace=off integrations-2162
//
// A missing service or credential fails the test: an unconfigured run is unverified, not green.
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { bringUpRealChatModel } from "../uat/specs/real-chat-signin.js";
import { shouldBindCheapestModel } from "./live-chat-model.js";

const OWNER_EMAIL = process.env.LIVE_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
if (!OWNER_EMAIL || !OWNER_PASSWORD) {
  throw new Error(
    "Set LIVE_OWNER_EMAIL and LIVE_OWNER_PASSWORD to the instance owner's sign-in before running " +
      "this test. The development password is not in this repository; it is kept in the memory " +
      "note named dev-instance-lan-spinup-trusted-origins."
  );
}
const OWNER = { email: OWNER_EMAIL, password: OWNER_PASSWORD };

const HA_MCP_URL = process.env.LIVE_HA_MCP_URL ?? "";
const HA_TOKEN = process.env.LIVE_HA_TOKEN ?? "";
const RADARR_URL = process.env.LIVE_RADARR_URL ?? "";
const RADARR_KEY = process.env.LIVE_RADARR_KEY ?? "";
const RADARR_SPEC_FILE = process.env.LIVE_RADARR_SPEC_FILE ?? "";

function requireEnv(names: Record<string, string>): void {
  const missing = Object.entries(names)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`unverified: set ${missing.join(", ")} to run this test`);
}

async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(OWNER.email);
  await page.getByLabel(/password/i).fill(OWNER.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();

  // A freshly provisioned owner lands on the first-run wizard.
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const nav = page.getByRole("navigation").first();
  await expect(skipSetup.or(nav).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(nav).toBeVisible();
}

async function ensureChatModel(page: Page) {
  if (shouldBindCheapestModel(process.env)) await bringUpRealChatModel(page);
}

// A failed check names the leak without echoing the credential into the report.
async function expectCredentialAbsent(page: Page, credential: string) {
  const pageText = (await page.locator("body").textContent()) ?? "";
  expect(pageText.includes(credential), "credential leaked to the page").toBe(false);
}

// The drawer keeps its last conversation; a fresh chat comes from the Conversations overlay.
// Sending waits until the drawer's clear is acknowledged and the transcript is empty.
async function startSideChat(page: Page) {
  await page.getByRole("button", { name: "Open conversations" }).click();
  const cleared = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === "/api/chat/clear" &&
      url.searchParams.get("surface") === "drawer"
    );
  });
  await page.getByRole("button", { name: "New side chat", exact: true }).click();
  expect((await cleared).status()).toBe(204);
  await expect(page.getByRole("dialog").locator(".chatd-msg")).toHaveCount(0);
}

function toolsMeta(page: Page) {
  return page.locator(".intg-tools .jds-section-head__meta");
}

async function openIntegrationsPane(page: Page) {
  await page.goto("/settings?section=integrations");
  await expect(page.getByRole("button", { name: "Add connection" })).toBeVisible();
}

// Reruns must not trip the duplicate-name 400: remove a leftover connection first.
async function removeConnectionIfPresent(page: Page, name: string) {
  await openIntegrationsPane(page);
  const row = page.locator(".set-row", { hasText: name }).first();
  if ((await row.count()) === 0) return;
  await row.getByRole("button", { name: "Configure" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Add connection" })).toBeVisible();
}

test.describe("integrations live path (#2162)", () => {
  test("MCP: connect Home Assistant, discover real tools, see them enabled", async ({ page }) => {
    requireEnv({ LIVE_HA_MCP_URL: HA_MCP_URL, LIVE_HA_TOKEN: HA_TOKEN });
    test.setTimeout(180_000);

    await signInThroughUi(page);
    await removeConnectionIfPresent(page, "Home Assistant");

    await page.getByRole("button", { name: "Add connection" }).click();
    // MCP server is the default kind.
    await page.getByLabel("Name").fill("Home Assistant");
    await page.getByLabel("URL").fill(HA_MCP_URL);
    await page.getByLabel("Credential").fill(HA_TOKEN);
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // Detail view: discovery really happened against the live HA MCP server.
    await expect(toolsMeta(page)).toHaveText(/^\d+ of \d+ on$/, { timeout: 60_000 });
    await expect(page.getByText("Connected").first()).toBeVisible();
    const toolsOn = (await toolsMeta(page).textContent()) ?? "";
    expect(Number.parseInt(toolsOn, 10)).toBeGreaterThan(0);

    // The credential must never come back to the browser.
    await expectCredentialAbsent(page, HA_TOKEN);

    // The list row shows the connection as a real MCP connection.
    await openIntegrationsPane(page);
    const row = page.locator(".set-row", { hasText: "Home Assistant" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("MCP")).toBeVisible();
    await expect(row.getByText("Connected")).toBeVisible();
  });

  test("OpenAPI: connect Radarr with a pasted spec, opt in a group, use it from chat", async ({
    page,
    request
  }) => {
    requireEnv({
      LIVE_RADARR_URL: RADARR_URL,
      LIVE_RADARR_KEY: RADARR_KEY,
      LIVE_RADARR_SPEC_FILE: RADARR_SPEC_FILE
    });
    test.setTimeout(900_000);

    // Ground truth straight from Radarr, so the chat answer below cannot be a guess. A single
    // movie looked up by id keeps the tool result inside the response size cap — the full
    // library listing is megabytes and would come back truncated.
    const movieResponse = await request.get(`${RADARR_URL}/api/v3/movie`, {
      headers: { "X-Api-Key": RADARR_KEY }
    });
    expect(movieResponse.ok()).toBe(true);
    const movies = (await movieResponse.json()) as { id: number; title: string }[];
    expect(movies.length).toBeGreaterThan(0);
    const probeMovie = movies.at(-1);
    if (!probeMovie) throw new Error("Radarr returned an empty movie list");
    expect(probeMovie.title.length).toBeGreaterThan(0);

    await signInThroughUi(page);
    await ensureChatModel(page);
    await removeConnectionIfPresent(page, "Radarr");

    await page.getByRole("button", { name: "Add connection" }).click();
    await page
      .getByRole("group", { name: "Kind" })
      .getByRole("button", { name: "API", exact: true })
      .click();
    await page.getByLabel("Name", { exact: true }).fill("Radarr");
    await page.getByLabel("URL").fill(RADARR_URL);
    await page.getByLabel("Credential").fill(RADARR_KEY);
    // "Send as" already defaults to Header with name X-Api-Key — Radarr's exact scheme.
    await page.getByRole("button", { name: "Paste the spec" }).click();
    await page.getByLabel("Spec").fill(readFileSync(RADARR_SPEC_FILE, "utf8"));
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    // Radarr's spec converts to far more than 30 tools, so every tool starts off.
    await expect(
      page.getByText("This app has a lot of tools, so they start off.", { exact: false })
    ).toBeVisible({ timeout: 60_000 });
    // The tools count reads "N of M on" since #3033 dropped the "always ask" tally.
    await expect(toolsMeta(page)).toHaveText(/^0 of \d+ on$/);

    // Turn on the movie tools through their real switches. Each switch's checkbox input is
    // visually hidden; the user clicks the styled label.
    await page.getByLabel("Search tools").fill("movie");
    const switches = page.getByRole("checkbox", { name: /^Enable / });
    await expect(switches.first()).toBeAttached();
    for (const box of await switches.all()) {
      if (!(await box.isChecked())) await box.locator("xpath=ancestor::label").click();
    }
    await expect(toolsMeta(page)).toHaveText(/^[1-9]\d* of \d+ on$/, { timeout: 15_000 });

    // The credential must never come back to the browser.
    await expectCredentialAbsent(page, RADARR_KEY);

    // Chat proof: a fresh conversation, an ask only a real Radarr call can answer.
    await page.getByRole("button", { name: /^(Chat with .+|Open chat)$/ }).click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await expect(composer).toBeVisible();
    await startSideChat(page);

    await composer.fill(
      `Use the Radarr connection's tools to look up the movie with id ${probeMovie.id} ` +
        "in my Radarr library and reply with its exact title."
    );
    await composer.press("Enter");

    // First use of an external connection's tools raises an Approve/Reject card in the drawer
    // (gateway confirm policy for outbound tools). Approve it like a real user, then nudge the
    // model to continue — approval does not auto-resume the turn.
    await expect(page.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible({
      timeout: 300_000
    });
    await page.getByRole("button", { name: "Approve", exact: true }).first().click();
    await composer.fill("Approved. Please fetch it now and reply with the exact title.");
    await composer.press("Enter");

    // The model cannot guess which title belongs to that id: the exact title appearing proves
    // the tool call went through Moss -> Radarr and back.
    await expect(page.getByRole("dialog").getByText(probeMovie.title).first()).toBeVisible({
      timeout: 300_000
    });
    await expectCredentialAbsent(page, RADARR_KEY);
  });
});
