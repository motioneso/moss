// Live-Path Gate for #3027 - Moss answers an email question in normal time, and the API keeps
// answering other requests while it embeds. Runs against a REAL dev instance: real API, real
// database, real mail account and model. Nothing is mocked.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:<port> LIVE_OWNER_PASSWORD=... \
//     npx playwright test --config playwright.live.config.ts pool-hang-3027
import { expect, test, type Page } from "@playwright/test";

const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  throw new Error("Set LIVE_OWNER_PASSWORD to the development instance sign-in password.");
}
const OWNER = { email: "ben@ben.com", password: OWNER_PASSWORD };
const SHOTS = process.env.LIVE_SHOT_DIR ?? "/tmp/pool-hang-3027";

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

test("an email question finishes in normal time while the API stays responsive", async ({
  page
}) => {
  test.setTimeout(300_000);
  await signInThroughUi(page);

  const latencies: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const startedAt = Date.now();
      await page.request.get("/api/health").catch(() => undefined);
      latencies.push(Date.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await drawer.getByRole("button", { name: "New chat" }).click();
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(
    "List the five most recent emails in my inbox with sender and subject. Use the email listing tool."
  );
  const sentAt = Date.now();
  await composer.press("Enter");
  await expect(drawer.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 240_000
  });
  const turnMs = Date.now() - sentAt;

  probing = false;
  await probe;
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor((latencies.length - 1) / 2)];
  const max = latencies[latencies.length - 1];
  await drawer.screenshot({ path: `${SHOTS}/email-answer.png` });
  console.log(
    `[3027] chat turn ${turnMs} ms; health probes ${latencies.length}, p50 ${p50} ms, max ${max} ms`
  );

  await expect(drawer.getByText(/stopped/i)).toHaveCount(0);
  expect(turnMs).toBeLessThan(120_000);
  expect(max).toBeLessThan(500);
});
