import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

// Park Press check 5 (PR 3349): Meetings delete cancel, and the companion link request screen.
// Fresh owner signed up through the real screen. No Moss response is intercepted. The "Mac" is a
// plain HTTP client of the real pairing routes. An unreadable request is created by really
// stopping the server container.
test.use({ trace: "off", screenshot: "off", video: "off" });

// 64 characters is the longest name the API accepts.
const LONG_DEVICE_NAME = "Ben's extraordinarily long-named MacBook Pro 16-inch Space Black";

async function startMacLinkRequest(
  baseURL: string,
  deviceName: string
): Promise<{ readonly code: string }> {
  const verifier = randomUUID() + randomUUID();
  const verifierHash = createHash("sha256").update(verifier).digest("base64url");
  const response = await fetch(`${baseURL}/api/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceName,
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "15.0",
      verifierHash
    })
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { approvalPath: string };
  const code = new URLSearchParams(new URL(body.approvalPath, baseURL).hash.slice(1)).get("code");
  expect(code).toBeTruthy();
  return { code: code as string };
}

async function openLinkRequest(page: Page, baseURL: string, code: string): Promise<void> {
  // The link a Mac opens is a full navigation by design.
  await page.goto(`${baseURL}/link/trail-marker#code=${code}`);
}

test("Meetings delete cancels safely and the companion link request distinguishes its states", async ({
  page
}) => {
  test.setTimeout(300_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) throw new Error("UAT project environment is not set");

  await signInUatAdmin(page);

  // ---- Meetings: delete cancel keeps the meeting (confirmed by reload) ----
  const title = "Park Press delete-cancel check";
  const created = await page.request.post("/api/meetings/records", {
    data: { requestKey: randomUUID(), title }
  });
  expect(created.status()).toBe(201);
  const meetingId = (await created.json()).meeting.id as string;

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Meetings" })
    .click();
  const row = page
    .locator(".meetings-history-row")
    .filter({ has: page.getByText(title, { exact: true }) });
  await row.click();
  await expect(page).toHaveURL(new RegExp(`id=${meetingId}`));

  const actions = page.getByRole("button", { name: "Meeting actions", exact: true });
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete meeting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this meeting?" });
  await expect(dialog).toBeVisible();
  // Initial focus is Cancel (the safe choice).
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  // Escape closes without deleting, and focus returns to a control on the page.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await page.request.get(`/api/meetings/records/${meetingId}`)).status()).toBe(200);
  await expect(actions).toBeFocused();
  // Reopen and use the Cancel button this time.
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete meeting", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  expect((await page.request.get(`/api/meetings/records/${meetingId}`)).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Edit meeting title", exact: true })).toHaveText(
    title
  );

  // ---- Companion: pending request with a long device name ----
  const pending = await startMacLinkRequest(baseURL, LONG_DEVICE_NAME);
  await openLinkRequest(page, baseURL, pending.code);
  await expect(page.getByRole("heading", { name: "Do you recognise this Mac?" })).toBeVisible();
  const longName = page.locator("strong").filter({ hasText: LONG_DEVICE_NAME }).first();
  await expect(longName).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: (() => {
        const strong = document.querySelector("strong");
        const rect = strong?.getBoundingClientRect();
        return rect ? rect.right - window.innerWidth : 0;
      })()
    }));
    expect(overflow.doc, `page scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
    expect(overflow.card, `device name runs off screen at ${width}px`).toBeLessThanOrEqual(0);
    // The whole name stays in the text (wrapped, not truncated).
    expect(await longName.textContent()).toBe(LONG_DEVICE_NAME);
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- Invalid code is shown as an unusable request, with no retry ----
  await openLinkRequest(page, baseURL, "not-a-real-code");
  const invalidAlert = page.getByRole("alert");
  await expect(invalidAlert).toContainText(/no longer open|couldn't be used/);
  const invalidText = (await invalidAlert.textContent()) ?? "";
  await expect(page.getByRole("button", { name: "Check request again" })).toHaveCount(0);

  // ---- Approve, then the same request is closed (already answered), no retry ----
  await openLinkRequest(page, baseURL, pending.code);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  const decided = page.waitForResponse((r) => r.url().endsWith("/api/companion/pair/decide"));
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  expect((await decided).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "That Mac is connected" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("is linked");
  await openLinkRequest(page, baseURL, pending.code);
  // An approved attempt reads fine and shows the connected state, with no error and no retry.
  await expect(page.getByRole("heading", { name: "That Mac is connected" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check request again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  const closedText = (await page.getByRole("status").first().textContent()) ?? "";

  // ---- Unavailable read: the server really stops. Different message, and a retry. ----
  const fresh = await startMacLinkRequest(baseURL, "Second example Mac");
  await openLinkRequest(page, baseURL, fresh.code);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  const stopped = () =>
    execFileSync("docker", buildUatComposeArgs(projectName, ["stop", "jarv1s"]), {
      stdio: "inherit"
    });
  stopped();
  try {
    // Retry is only offered after a read fails; force a failing read through the screen itself.
    // Reload would not work with the server down, so use in-page retry after a decision attempt.
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    const unavailable = page.getByRole("alert");
    await expect(unavailable).toContainText("Couldn't confirm your answer");
    await expect(unavailable).not.toContainText(invalidText);
    const retry = page.getByRole("button", { name: "Check request again" });
    await expect(retry).toBeVisible();
    // Retry while still down: stays unavailable, answers stay disabled.
    await retry.click();
    await expect(page.getByRole("alert")).toContainText("Couldn't check this request");
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    expect(closedText).not.toContain("Couldn't check this request");
  } finally {
    // docker compose restart also starts a stopped container.
    await restartUatStack(projectName, baseURL);
  }
  // After the server returns, retry recovers to the real pending request.
  await page.getByRole("button", { name: "Check request again" }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled({
    timeout: 30_000
  });
  console.log(
    "PARK_PRESS_5_MEETINGS_COMPANION delete-cancel, long names, invalid vs closed vs unavailable"
  );
});
