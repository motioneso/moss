import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_ID,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

export const uatLevel = {
  level: "multi-user",
  without: [],
  withWorkshopStorageFixture: true
} as const;

const MODULE_ID = "uat-workshop-word";
const SAVE_QUEUE = `${MODULE_ID}.word-save`;
const WORD_ID = "quasar";
const execFileAsync = promisify(execFile);

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(process.env.JARVIS_UAT_BASE_URL!);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
    if (await skipAnyway.isVisible().catch(() => false)) await skipAnyway.click();
  }
  await expect(userMenu).toBeVisible({ timeout: 30_000 });
}

async function signOut(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("form.auth-form")).toBeVisible({ timeout: 30_000 });
}

async function queue(page: Page, queueName: string, jobKind: string): Promise<APIResponse> {
  return page.request.post(`/api/modules/${MODULE_ID}/queues/${queueName}/run`, {
    data: { jobKind, params: { wordId: WORD_ID } }
  });
}

const queueSave = (page: Page) => queue(page, SAVE_QUEUE, `${MODULE_ID}.word-save`);
const queueRemove = (page: Page) =>
  page.request.post(`/api/modules/${MODULE_ID}/queues/${MODULE_ID}.word-remove/run`, {
    data: { jobKind: `${MODULE_ID}.word-remove`, params: { wordId: WORD_ID } }
  });

test("owner draft storage survives queues, reloads, restart, and stays private", async ({
  page
}) => {
  test.setTimeout(420_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) {
    throw new Error("JARVIS_UAT_PROJECT_NAME / JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  if (!projectName.startsWith("uat-")) throw new Error("Refusing non-UAT database probes");
  const queryFixture = (statement: string) =>
    execFileAsync(
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
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement
      ])
    );

  const waitForFixtureJobs = () =>
    expect
      .poll(
        async () => {
          const jobs = await queryFixture(`SELECT count(*) FROM pgboss.job
            WHERE name IN ('${SAVE_QUEUE}', '${MODULE_ID}.word-remove')
              AND state <> 'completed';`);
          return jobs.stdout.trim();
        },
        { timeout: 45_000, message: "Every accepted fixture job must complete successfully" }
      )
      .toBe("0");

  // The seed installs the draft after the initial app boot. Restart reruns discovery and starts
  // the worker with the exact staged package and owner row before the browser reaches the module.
  await restartUatStack(projectName, baseURL);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);

  const queueRequests: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().includes(`/api/modules/${MODULE_ID}/queues/`)) {
      const body = request.postDataJSON() as Record<string, unknown> | null;
      if (body) queueRequests.push(body);
    }
  });

  const moduleLink = page.getByRole("link", { name: "Workshop Word", exact: true });
  const modulePath = await moduleLink.getAttribute("href");
  expect(modulePath).toBeTruthy();
  await moduleLink.click();
  await expect(page.getByRole("heading", { name: "Quasar" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Not saved yet.");
  await expect(page.getByRole("button", { name: "Save word" })).toBeEnabled();

  await page.getByRole("button", { name: "Save word" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved in your private list.", {
    timeout: 45_000
  });
  expect(queueRequests).toContainEqual({
    jobKind: `${MODULE_ID}.word-save`,
    params: { wordId: WORD_ID }
  });
  expect(JSON.stringify(queueRequests)).not.toContain("Quasar");
  await waitForFixtureJobs();
  const persisted = await queryFixture(`SELECT data FROM pgboss.job
    WHERE name = '${SAVE_QUEUE}' ORDER BY created_on;`);
  expect(
    persisted.stdout
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row))
  ).toEqual([
    {
      actorUserId: UAT_ADMIN_ID,
      moduleId: MODULE_ID,
      jobKind: `${MODULE_ID}.word-save`,
      manifestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      params: { wordId: WORD_ID }
    }
  ]);

  // The confirmed value is read from the worker's tool, so reload must preserve it without any
  // browser state. A restart proves the worker process and KV path survive independently.
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Saved in your private list.", {
    timeout: 30_000
  });
  await restartUatStack(projectName, baseURL);
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Saved in your private list.", {
    timeout: 45_000
  });

  // Exercise the same other account as both a regular user and an admin. Promotion uses the
  // supported admin API; no fake session or test-only privilege bypass is involved.
  const assertOtherActorDenied = async () => {
    await expect(page.getByRole("link", { name: "Workshop Word", exact: true })).toHaveCount(0);
    await page.goto(new URL(modulePath!, baseURL).href);
    await expect(page.getByRole("heading", { name: "Quasar" })).toHaveCount(0);
    const readDenied = await page.request.post(
      `/api/ai/assistant-tools/${MODULE_ID}.word.list/invoke`,
      { data: { input: {} } }
    );
    expect([403, 404]).toContain(readDenied.status());
    expect([403, 404]).toContain((await queueSave(page)).status());
    // Independently exercise the worker's SQL role: the HTTP ownership gate must not be
    // the only thing preventing another actor (including an admin) from accessing draft KV.
    const actorContext = `BEGIN; SET LOCAL ROLE jarvis_worker_runtime;
      SET LOCAL app.actor_user_id = '${UAT_SECOND_OWNER_ID}';
      SET LOCAL app.current_module_id = '${MODULE_ID}';`;
    const hidden = await queryFixture(`${actorContext}
      SELECT count(*) FROM app.module_kv WHERE module_id = '${MODULE_ID}'; ROLLBACK;`);
    expect(hidden.stdout.trim()).toBe("0");
    await expect(
      queryFixture(`${actorContext}
      INSERT INTO app.module_kv(module_id, namespace, scope, owner_user_id, key, value)
      VALUES ('${MODULE_ID}', '${MODULE_ID}.saved', 'user', '${UAT_SECOND_OWNER_ID}',
        'forbidden', '{"wordId":"quasar"}'); ROLLBACK;`)
    ).rejects.toMatchObject({ stderr: expect.stringContaining("row-level security") });
  };
  await signOut(page);
  await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  await assertOtherActorDenied();
  await signOut(page);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  const promoted = await page.request.post(`/api/admin/users/${UAT_SECOND_OWNER_ID}/promote`);
  expect(promoted.status()).toBe(200);
  expect((await promoted.json()).user.isInstanceAdmin).toBe(true);
  await signOut(page);
  await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  await assertOtherActorDenied();

  // Return to the owner and use the supported draft-delete endpoint so the fixture's module
  // folder and row are purged before the isolated Compose teardown.
  await signOut(page);
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  // Other actors were denied while the saved row still existed. Return through the real
  // navigation before exercising idempotent removal and cleanup as its owner.
  await page.getByRole("link", { name: "Workshop Word", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved in your private list.");
  const ownership =
    await queryFixture(`SELECT count(*) FILTER (WHERE owner_user_id = '${UAT_ADMIN_ID}')
    || '|' || count(*) FILTER (WHERE owner_user_id IS DISTINCT FROM '${UAT_ADMIN_ID}'::uuid)
    FROM app.module_kv WHERE module_id = '${MODULE_ID}';`);
  expect(ownership.stdout.trim()).toBe("1|0");
  // Two same-queue requests in the five-second window collapse to one job.
  const dedupFirst = await queueSave(page);
  const dedupSecond = await queueSave(page);
  expect(dedupFirst.status()).toBe(202);
  expect((await dedupFirst.json()).jobId).toEqual(expect.any(String));
  expect(dedupSecond.status()).toBe(202);
  expect((await dedupSecond.json()).jobId).toBeNull();
  // Independent queues do not promise save-before-remove ordering. Drain saves first.
  await waitForFixtureJobs();

  await page.getByRole("button", { name: "Remove saved word" }).click();
  await expect(page.getByRole("status")).toHaveText("Removed from your private list.", {
    timeout: 45_000
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Not saved yet.", { timeout: 30_000 });
  // The seventh remove request demonstrates the route's honest 429 response without any save
  // retry that could resurrect the just-removed record.
  const burst = await Promise.all(Array.from({ length: 7 }, () => queueRemove(page)));
  expect(burst.some((response) => response.status() === 429)).toBe(true);
  await expect(page.getByRole("status")).toHaveText("Not saved yet.");

  await waitForFixtureJobs();
  const removed = await queryFixture(
    `SELECT count(*) FROM app.module_kv WHERE module_id = '${MODULE_ID}';`
  );
  expect(removed.stdout.trim()).toBe("0");

  const purge = await page.request.delete(`/api/admin/modules/${MODULE_ID}/draft`);
  expect(purge.status()).toBe(200);
  await restartUatStack(projectName, baseURL);

  const modules = (await (await page.request.get("/api/me/modules")).json()) as {
    modules?: Array<{ id?: string }>;
  };
  expect(modules.modules?.some((module) => module.id === MODULE_ID)).toBe(false);
  const artifact = await execFileAsync("docker", [
    ...buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "sh",
      "-c",
      `test ! -e /data/modules/${MODULE_ID} && test ! -e /data/modules/.builds/${MODULE_ID}`
    ])
  ]);
  expect(artifact.stdout).toBe("");
  const cleanup = await execFileAsync("docker", [
    ...buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-tA",
      "-c",
      `SELECT (SELECT count(*) FROM app.external_modules WHERE id = '${MODULE_ID}') || '|' || (SELECT count(*) FROM app.module_kv WHERE module_id = '${MODULE_ID}') || '|' || (SELECT count(*) FROM pgboss.job WHERE name IN ('${SAVE_QUEUE}', '${MODULE_ID}.word-remove') AND state NOT IN ('completed', 'cancelled', 'failed'))`
    ])
  ]);
  expect(cleanup.stdout.trim()).toBe("0|0|0");
});
