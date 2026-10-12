import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { execUatSql } from "./job-search-board-sql.js";
import { requireUatBaseURL, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withClassifierFixture: true
} as const;

// The existing fixture is text-only. Real image success is verified separately on the Mac.
test("paired Mac Test stores nothing and a text-only judge refuses pictures without fallback", async ({
  page
}) => {
  await signInUatAdmin(page);
  const project = requireUatProjectName();
  const models = await (await page.request.get("/api/ai/models")).json();
  const model = models.models.find(
    (row: { displayName: string }) => row.displayName === "UAT Classifier Fixture Model"
  );
  expect(model).toBeTruthy();
  const bound = await page.request.put("/api/ai/services/sorting/binding", {
    data: { binding: { kind: "model", modelId: model.id } }
  });
  expect(bound.status()).toBe(200);
  const owner = execUatSql(
    project,
    "SELECT id FROM app.users WHERE is_instance_admin = true LIMIT 1"
  ).trim();
  const account = randomUUID();
  const block = randomUUID();
  execUatSql(
    project,
    `
    INSERT INTO app.connector_accounts (id, provider_id, owner_user_id, scopes, status, encrypted_secret)
    VALUES ('${account}', 'google-calendar', '${owner}', '{}', 'active', '{}');
    INSERT INTO app.calendar_events (id, connector_account_id, owner_user_id, title, starts_at, ends_at, external_id, external_metadata)
    VALUES ('${block}', '${account}', '${owner}', 'Review checkout accessibility', now() - interval '1 minute', now() + interval '1 hour', '${block}', '{"jarvisCreated":true,"source":"createEvent"}');
  `
  );
  const verifier = randomBytes(32).toString("base64url");
  const pair = await page.request.post("/api/companion/pair", {
    data: {
      deviceName: "Synthetic judge Mac",
      platform: "macos",
      appVersion: "0.1.0",
      osVersion: "14.0",
      verifierHash: createHash("sha256").update(verifier).digest("base64url")
    }
  });
  expect(pair.status()).toBe(200);
  const started = await pair.json();
  // Approve through the actual link screen, using the signed-in owner.
  await page.goto(new URL(started.approvalPath, requireUatBaseURL()).href);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "That Mac is connected" })).toBeVisible();
  const redeemed = await page.request.post("/api/companion/pair/redeem", {
    data: { attemptId: started.attemptId, verifier }
  });
  expect(redeemed.status()).toBe(200);
  const headers = { authorization: `Bearer ${(await redeemed.json()).credential}` };
  const context = await page.request.post("/api/companion/focus/context", { headers, data: {} });
  expect(await context.json()).toMatchObject({ judgeTakesImages: false, block: { id: block } });
  const count = () =>
    Number(
      execUatSql(
        project,
        `SELECT count(*) FROM app.focus_judgments WHERE block_ref = '${block}'`
      ).trim()
    );
  const before = count();
  const data = {
    blockId: block,
    appName: "Firefox",
    windowTitle: "Synthetic page",
    observedAt: new Date().toISOString(),
    image: "data:image/jpeg;base64,/9j/2Q=="
  };
  const result = await page.request.post("/api/companion/focus/judge", {
    headers,
    data: { ...data, test: true }
  });
  expect(result.status()).toBe(200);
  expect(await result.json()).toMatchObject({
    judgmentId: "",
    label: "insufficient_evidence",
    nudge: false
  });
  expect(count()).toBe(before);
  const normal = await page.request.post("/api/companion/focus/judge", { headers, data });
  expect(normal.status()).toBe(200);
  expect(await normal.json()).toMatchObject({ label: "insufficient_evidence", nudge: false });
  expect(count()).toBe(before + 1);
  execUatSql(project, `DELETE FROM app.connector_accounts WHERE id = '${account}'`);
});
