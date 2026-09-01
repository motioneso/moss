// Live-Path Gate for #2162 — connecting Moss to real external services through the real UI.
// Runs against a REAL running dev instance: real API, real Postgres with RLS, and two REAL
// services on the LAN: a Home Assistant MCP server and a Radarr install (OpenAPI, pasted spec).
// Nothing is mocked. See docs/DEVELOPMENT_STANDARDS.md.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:5173 \
//   LIVE_HA_MCP_URL=... LIVE_HA_TOKEN=... \
//   LIVE_RADARR_URL=... LIVE_RADARR_KEY=... LIVE_RADARR_SPEC_FILE=... \
//     npx playwright test --config playwright.live.config.ts integrations-2162
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const OWNER = { email: "ben@ben.com", password: "jarvistest123!" };

const HA_MCP_URL = process.env.LIVE_HA_MCP_URL ?? "";
const HA_TOKEN = process.env.LIVE_HA_TOKEN ?? "";
const RADARR_URL = process.env.LIVE_RADARR_URL ?? "";
const RADARR_KEY = process.env.LIVE_RADARR_KEY ?? "";
const RADARR_SPEC_FILE = process.env.LIVE_RADARR_SPEC_FILE ?? "";

async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(OWNER.email);
  await page.getByLabel(/password/i).fill(OWNER.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
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
    test.skip(!HA_MCP_URL || !HA_TOKEN, "needs LIVE_HA_MCP_URL and LIVE_HA_TOKEN");
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
    await expect(page.getByText(/^\d+ tools on$/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Connected").first()).toBeVisible();
    const toolsOn = (await page.getByText(/^\d+ tools on$/).textContent()) ?? "";
    expect(Number.parseInt(toolsOn, 10)).toBeGreaterThan(0);

    // The credential must never come back to the browser.
    const pageText = (await page.locator("body").textContent()) ?? "";
    expect(pageText).not.toContain(HA_TOKEN);

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
    test.skip(
      !RADARR_URL || !RADARR_KEY || !RADARR_SPEC_FILE,
      "needs LIVE_RADARR_URL, LIVE_RADARR_KEY and LIVE_RADARR_SPEC_FILE"
    );
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

    // Radarr's spec converts to far more than 30 tools, so groups start off.
    await expect(page.getByText("Groups start off. Turn on the ones Moss should use.")).toBeVisible(
      { timeout: 60_000 }
    );
    await expect(page.getByText("0 tools on")).toBeVisible();

    // Turn on the Movie group through the real switch.
    // The switch's real checkbox input is visually hidden; the user clicks the styled label.
    await page
      .getByRole("checkbox", { name: "Enable group Movie", exact: true })
      .locator("xpath=ancestor::label")
      .click();
    await expect(page.getByText(/^[1-9]\d* tools on$/)).toBeVisible({ timeout: 15_000 });

    // The credential must never come back to the browser.
    const pageText = (await page.locator("body").textContent()) ?? "";
    expect(pageText).not.toContain(RADARR_KEY);

    // Chat proof: a fresh conversation, an ask only a real Radarr call can answer.
    await page.getByRole("button", { name: /^(Chat with .+|Open chat)$/ }).click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await expect(composer).toBeVisible();
    await page.getByRole("button", { name: /^New chat$/ }).click();

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
  });
});
