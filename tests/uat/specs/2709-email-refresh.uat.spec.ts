import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD, UAT_ADMIN_ID } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

// Repo live-path policy explicitly forbids screenshots. DOM, API, and bounded log assertions
// below provide the run evidence, so disable Playwright's failure trace artifacts for this spec.
test.use({ trace: "off" });

const execFileAsync = promisify(execFile);
const STALE_FINISHED_AT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
const GREENMAIL_OPTS =
  "-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp " +
  "-Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users.login=email " +
  "-Dgreenmail.users=probe:probe-pw@greenmail.test";

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT fixture target");
  return project;
}

function localDay(date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "longOffset"
    })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}

async function json(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    { path, init }
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

async function startGreenmail(projectName: string): Promise<string> {
  const name = `${projectName}-greenmail`;
  await execFileAsync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--network",
      `${projectName}_jarv1s`,
      "--network-alias",
      "emailfixture",
      "--env",
      `GREENMAIL_OPTS=${GREENMAIL_OPTS}`,
      "greenmail/standalone:2.1.0"
    ],
    { maxBuffer: 1_000_000 }
  );

  const probe = `import net from "node:net";
await Promise.all([3143, 3025].map((port) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "emailfixture", port });
  socket.setTimeout(2_000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); reject(new Error("fixture port timeout")); });
  socket.once("error", reject);
})));`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await execFileAsync(
        "docker",
        buildUatComposeArgs(projectName, [
          "exec",
          "-T",
          "jarv1s",
          "node",
          "--input-type=module",
          "-e",
          probe
        ]),
        { maxBuffer: 1_000_000 }
      );
      console.log(
        "[live proof] isolated GreenMail IMAP/SMTP ports are reachable on the UAT network"
      );
      return name;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`GreenMail did not become ready on ${projectName}_jarv1`, { cause: lastError });
}

async function seedStaleEmailAccount(page: Page, projectName: string): Promise<string> {
  const created = await json(page, "/api/connectors/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "imap-proton",
      scopes: ["email.read"],
      tokenPayload: {
        kind: "imap-password",
        providerId: "imap-proton",
        username: "probe@greenmail.test",
        password: "probe-pw",
        imapHost: "emailfixture",
        imapPort: 3143,
        imapTls: false,
        smtpHost: "emailfixture",
        smtpPort: 3025,
        smtpSecurity: "none"
      }
    })
  });
  expect(created.status).toBe(201);
  const accountId = (created.body as { account: { id: string; providerType: string } }).account.id;
  expect(accountId).toBeTruthy();
  expect((created.body as { account: { providerType: string } }).account.providerType).toBe("imap");

  // Stamp old sync metadata through the normal app-runtime role while RLS is active.
  const script = `import { ConnectorsRepository } from "/app/packages/connectors/src/repository.ts";
import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts";
void (async () => {
  const runner = createAppRuntimeRunner();
  try {
    await runner.withDataContext({ actorUserId: ${JSON.stringify(UAT_ADMIN_ID)}, requestId: "uat:2709:stale" }, async (db) => {
      const repository = new ConnectorsRepository();
      await repository.markSyncStarted(db, ${JSON.stringify(accountId)}, {
        startedAt: new Date(${JSON.stringify(new Date(STALE_FINISHED_AT.getTime() - 60_000).toISOString())}),
        trigger: "on-connect"
      });
      await repository.markSyncFinished(db, ${JSON.stringify(accountId)}, {
        finishedAt: new Date(${JSON.stringify(STALE_FINISHED_AT.toISOString())}),
        status: "success",
        error: null,
        counts: { emailUpserted: 0, emailFailures: 0, truncated: false }
      });
    });
    console.log("seeded stale email sync metadata");
  } finally {
    await runner.destroy();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`;
  const seeded = await execFileAsync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "--eval",
      script
    ]),
    { maxBuffer: 1_000_000 }
  );
  console.log(`[UAT email fixture] ${seeded.stdout.trim()}`);
  return accountId;
}

async function createMorningDefinition(page: Page): Promise<string> {
  const created = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "UAT email refresh briefing",
      briefingType: "morning",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "07:00", timezone: "America/Los_Angeles" },
      selectedToolNames: ["email.listVisibleMessages", "tasks.list"]
    })
  });
  expect(created.status).toBe(201);
  return (created.body as { definition: { id: string } }).definition.id;
}

async function seedStaleBriefingRun(projectName: string, definitionId: string): Promise<string> {
  const capturedAt = new Date().toISOString();
  const staleAsOf = STALE_FINISHED_AT.toISOString();
  const script = `import { randomUUID } from "node:crypto";
import { createAppRuntimeRunner } from "/app/tests/uat/seed/connections.ts";
void (async () => {
  const runner = createAppRuntimeRunner();
  try {
    const runId = await runner.withDataContext({ actorUserId: ${JSON.stringify(UAT_ADMIN_ID)}, requestId: "uat:2709:baseline" }, async (db) => {
      const definition = await db.db
        .selectFrom("app.briefing_definitions")
        .select(["id", "owner_user_id"])
        .where("id", "=", ${JSON.stringify(definitionId)})
        .executeTakeFirst();
      if (!definition) throw new Error("UAT briefing definition missing");
      const createdAt = new Date(${JSON.stringify(capturedAt)});
      const run = await db.db
        .insertInto("app.briefing_runs")
        .values({
          id: randomUUID(),
          definition_id: definition.id,
          owner_user_id: definition.owner_user_id,
          status: "succeeded",
          run_kind: "manual",
          briefing_type: "morning",
          summary_text: "UAT baseline: email is stale and ready to refresh.",
          source_metadata: {
            sourceTimestamps: {
              version: 1,
              capturedAt: createdAt.toISOString(),
              sources: [{ source: "email", freshnessKind: "connector_sync", asOf: ${JSON.stringify(staleAsOf)} }]
            },
            structuredPayload: { version: 1, actionRows: [], catchUp: null }
          },
          created_at: createdAt
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.db
        .updateTable("app.briefing_definitions")
        .set({ last_run_at: createdAt, updated_at: createdAt })
        .where("id", "=", definition.id)
        .execute();
      return run.id;
    });
    console.log("UAT_STALE_BRIEFING_RUN=" + runId);
  } finally {
    await runner.destroy();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`;
  const seeded = await execFileAsync(
    "docker",
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "--eval",
      script
    ]),
    { maxBuffer: 1_000_000 }
  );
  const runId = seeded.stdout.match(/UAT_STALE_BRIEFING_RUN=([0-9a-f-]{36})/)?.[1];
  if (!runId)
    throw new Error(`Could not read seeded briefing run ID: ${seeded.stdout.slice(0, 300)}`);
  console.log(`[UAT briefing fixture] seeded stale baseline ${runId}`);
  return runId;
}

async function waitForEmailRefresh(
  page: Page,
  refreshId: string
): Promise<{
  status: string;
  accounts: Array<{ status: string; counts: Record<string, number> }>;
}> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await json(page, `/api/connectors/email-refresh/${refreshId}`);
    expect(response.status).toBe(200);
    const body = response.body as {
      status: string;
      accounts: Array<{ status: string; counts: Record<string, number> }>;
    };
    if (["succeeded", "partial", "failed"].includes(body.status)) return body;
    await page.waitForTimeout(1_000);
  }
  throw new Error("Email refresh did not reach a terminal state within 60 seconds");
}

test("stale email refresh finishes before one updated briefing is prepared", async ({ page }) => {
  test.setTimeout(240_000);
  const projectName = uatProject();
  let greenmailName: string | undefined;

  try {
    await page.clock.install({ time: new Date(localIso(localDay(), "10:00")) });
    await signIn(page);
    greenmailName = await startGreenmail(projectName);
    const accountId = await seedStaleEmailAccount(page, projectName);
    expect(accountId).toBeTruthy();

    const definitionId = await createMorningDefinition(page);
    const baselineRunId = await seedStaleBriefingRun(projectName, definitionId);
    const baselineResponse = await json(
      page,
      `/api/briefings/definitions/${definitionId}/runs/${baselineRunId}`
    );
    expect(baselineResponse.status).toBe(200);
    const baseline = baselineResponse.body as {
      state: string;
      run: {
        id: string;
        status: string;
        summaryText: string;
        sourceMetadata: {
          sourceTimestamps?: { sources?: Array<{ source: string; asOf: string }> };
        };
      } | null;
    };
    expect(baseline.state).toBe("ready");
    expect(baseline.run?.id).toBe(baselineRunId);
    expect(baseline.run?.status).toBe("succeeded");
    expect(baseline.run?.summaryText.trim()).not.toBe("");
    expect(baseline.run?.sourceMetadata.sourceTimestamps?.sources).toContainEqual(
      expect.objectContaining({ source: "email", asOf: STALE_FINISHED_AT.toISOString() })
    );
    console.log("[live proof] GET API returned the nonblank baseline with stale email freshness");

    await page.goto(baseURL());
    await expect(page.locator(".today-hero")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Read the full morning briefing" })
    ).toBeVisible();
    const refreshButton = page.getByRole("button", { name: "Refresh email" });
    await expect(refreshButton).toBeVisible();

    const refreshPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const briefingPosts: Array<{ url: string; body: Record<string, unknown> }> = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = new URL(request.url());
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      if (url.pathname === "/api/connectors/email-refresh") {
        refreshPosts.push({ url: url.pathname, body });
      } else if (url.pathname === `/api/briefings/definitions/${definitionId}/run`) {
        briefingPosts.push({ url: url.pathname, body });
      }
    });
    const refreshResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/connectors/email-refresh"
    );
    const briefingResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/briefings/definitions/${definitionId}/run`
    );
    await refreshButton.click();
    const refreshResponse = await refreshResponsePromise;
    expect(refreshResponse.status()).toBe(202);
    const { refreshId } = (await refreshResponse.json()) as { refreshId: string };
    expect(refreshId).toBeTruthy();

    const terminal = await waitForEmailRefresh(page, refreshId);
    expect(["succeeded", "partial"]).toContain(terminal.status);
    expect(terminal.accounts).toHaveLength(1);
    expect(["succeeded", "partial"]).toContain(terminal.accounts[0]?.status);
    console.log(`[live proof] email refresh reached terminal ${terminal.status}`);

    const briefingResponse = await briefingResponsePromise;
    expect(briefingResponse.status()).toBe(202);
    expect(briefingPosts[0]?.body.idempotencyKey).toBe(refreshId);
    expect(refreshPosts).toHaveLength(1);
    expect(briefingPosts).toHaveLength(1);

    await expect
      .poll(
        async () => {
          const response = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
          if (response.status !== 200) return 0;
          return (response.body as { runs: Array<{ id: string }> }).runs.filter(
            (run) => run.id !== baselineRunId
          ).length;
        },
        { timeout: 30_000 }
      )
      .toBe(1);

    const latest = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    expect(latest.status).toBe(200);
    const runs = (latest.body as { runs: Array<{ id: string }> }).runs;
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.id)).toContain(baselineRunId);

    const refreshedRunId = runs.find((run) => run.id !== baselineRunId)?.id;
    expect(refreshedRunId).toBeTruthy();
    await expect
      .poll(
        async () => {
          const result = await json(
            page,
            `/api/briefings/definitions/${definitionId}/runs/${refreshedRunId}`
          );
          return (result.body as { state: string }).state;
        },
        { timeout: 15_000 }
      )
      .toBe("ready");

    const refreshedResponse = await json(
      page,
      `/api/briefings/definitions/${definitionId}/runs/${refreshedRunId}`
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = refreshedResponse.body as {
      state: string;
      run: {
        status: string;
        summaryText: string;
        sourceMetadata: {
          sourceTimestamps?: { sources?: Array<{ source: string; asOf: string | null }> };
        };
      } | null;
    };
    expect(refreshed.state).toBe("ready");
    expect(refreshed.run?.status).toBe("succeeded");
    expect(refreshed.run?.summaryText.trim()).not.toBe("");
    const refreshedEmailTimestamp = refreshed.run?.sourceMetadata.sourceTimestamps?.sources?.find(
      (source) => source.source === "email"
    )?.asOf;
    expect(refreshedEmailTimestamp).toBeTruthy();
    expect(new Date(refreshedEmailTimestamp ?? "").getTime()).toBeGreaterThan(
      STALE_FINISHED_AT.getTime()
    );
    await expect(page.getByRole("button", { name: "Refresh email" })).toHaveCount(0, {
      timeout: 60_000
    });
    await expect(page.getByText("Some sources are over a day old: Email.")).toHaveCount(0);

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Read the full morning briefing" })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh email" })).toHaveCount(0);
    console.log(
      `[live proof] browser created one fresh nonblank briefing run (${refreshedRunId}); Today removed the stale-email action`
    );
  } finally {
    if (greenmailName) {
      await execFileAsync("docker", ["rm", "--force", greenmailName], {
        maxBuffer: 1_000_000
      }).catch((error) => {
        console.error(`[UAT GreenMail cleanup] ${String(error).slice(0, 400)}`);
      });
    }
  }
});
