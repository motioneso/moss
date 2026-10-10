// tests/uat/specs/2911-shadow-purge-queue.uat.spec.ts
//
// #2911 live proof for the retired purge-queue tidy-up. The review found the worker role had no
// DELETE on the pgboss queue table and pg-boss swallowed the error, so the queue row stayed behind
// while the startup log claimed it was deleted. This spec proves, on a real stack with the real
// worker role, that a pre-seeded retired queue row is actually gone and the startup log tells the
// truth.
//
// It seeds the row exactly as an install that ran 0251 would have it, restarts only the app
// container so the chat worker runs its startup tidy-up, then reads pgboss.queue and the app log.
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { buildUatComposeArgs } from "../provisioner.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const RETIRED_QUEUE = "chat.purge-classifier-shadow-records";

function requireBaseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function requireProjectName(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return value;
}

function psql(projectName: string, sql: string): string {
  return execFileSync(
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
      "-t",
      "-A",
      "-c",
      sql
    ]),
    { encoding: "utf8" }
  ).trim();
}

/** Insert the retired queue row only if it is absent, the way an upgraded install would hold it. */
function seedRetiredQueue(projectName: string): void {
  psql(
    projectName,
    `INSERT INTO pgboss.queue (name, policy, retry_limit, retry_delay, retry_backoff,
       expire_seconds, retention_seconds, deletion_seconds, partition, table_name)
     VALUES ('${RETIRED_QUEUE}', 'standard', 3, 300, true, 900, 1209600, 604800, false,
             'job_common')
     ON CONFLICT (name) DO NOTHING`
  );
}

function queueRowCount(projectName: string): number {
  return Number(
    psql(projectName, `SELECT count(*) FROM pgboss.queue WHERE name = '${RETIRED_QUEUE}'`).trim()
  );
}

test("the retired shadow-purge queue is really gone after the worker starts (#2911)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const projectName = requireProjectName();

  await test.step("sign in so the app is ready to read its own log", async () => {
    await page.goto(requireBaseURL());
    await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
    await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
    const skip = page.getByRole("button", { name: "Skip setup" });
    const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
    await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
    if (await skip.isVisible()) {
      await skip.click();
      await page.getByRole("button", { name: "Skip anyway" }).click();
    }
    await expect(menu).toBeVisible({ timeout: 30_000 });
  });

  await test.step("seed the retired queue row and restart the app so the worker tidy-up runs", async () => {
    seedRetiredQueue(projectName);
    expect(queueRowCount(projectName)).toBe(1);
    execFileSync("docker", buildUatComposeArgs(projectName, ["restart", "jarv1s"]), {
      encoding: "utf8"
    });
  });

  await test.step("the queue row is gone from pgboss and the log says it was deleted", async () => {
    // The worker start can take a few seconds after the container reports healthy.
    await expect
      .poll(() => queueRowCount(projectName), {
        timeout: 120_000,
        message: `the retired queue ${RETIRED_QUEUE} was not deleted`
      })
      .toBe(0);

    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, ["logs", "--no-color", "jarv1s"]),
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    const retirementLines = logs
      .split(/\r?\n/)
      .filter((line) => line.includes("chat_classifier_shadow_purge_queue_retired"));
    expect(retirementLines.length, "the tidy-up must log its outcome").toBeGreaterThan(0);
    expect(retirementLines.join("\n")).toContain('"queueDeleted":true');
  });
});
