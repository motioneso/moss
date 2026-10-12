import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { startGreenmail } from "./3467-greenmail.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off" });

test("real mailbox notices create no commitments while an owner promise reaches Today", async ({
  page
}) => {
  test.skip(!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "A real economy model is required");
  test.setTimeout(600_000);
  const project = requireUatProjectName();
  let greenmail: string | undefined;
  try {
    await signInUatAdmin(page);
    const installed = await page.request.post("/api/onboarding/provider-install", {
      data: { providerKind: "anthropic" },
      timeout: 180_000
    });
    expect(installed.ok()).toBe(true);
    expect((await installed.json()).installState).toBe("installed");
    const model = await bringUpRealChatModel(page);
    const extractionBinding = await page.request.put(
      "/api/ai/services/module.connectors.email-extract/binding",
      { data: { binding: { kind: "model", modelId: model.id } } }
    );
    expect(extractionBinding.ok()).toBe(true);
    greenmail = await startGreenmail(project);
    execFileSync(
      "docker",
      buildUatComposeArgs(project, [
        "cp",
        "tests/uat/seed/3467-one-sided-fixture.ts",
        "jarv1s:/app/tests/uat/seed/3467-one-sided-fixture.ts"
      ])
    );
    const seeded = JSON.parse(
      execFileSync(
        "docker",
        buildUatComposeArgs(project, [
          "exec",
          "-T",
          "-e",
          "JARVIS_GATE_RUN=1",
          "-e",
          "JARVIS_UAT_SEED_CONFIRM=1",
          "jarv1s",
          "node_modules/.bin/tsx",
          "--tsconfig",
          "tsconfig.json",
          "tests/uat/seed/3467-one-sided-fixture.ts"
        ]),
        { encoding: "utf8" }
      ).trim()
    ) as { commitmentId: string; messagesDelivered: number };
    expect(seeded.messagesDelivered).toBe(5);
    const connected = await page.request.post("/api/connectors/accounts", {
      data: {
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
      }
    });
    expect(connected.status()).toBe(201);
    const refreshed = await page.request.post("/api/connectors/email-refresh", {
      data: { idempotencyKey: randomUUID() }
    });
    expect(refreshed.status()).toBe(202);
    const { refreshId } = await refreshed.json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/connectors/email-refresh/${refreshId}`)).json())
            .status,
        { timeout: 180_000, intervals: [1000, 2000, 4000] }
      )
      .toBe("succeeded");
    expect(
      Number(
        execUatSql(
          project,
          `SELECT count(*) FROM app.email_messages WHERE owner_user_id='${UAT_ADMIN_ID}'`
        )
      )
    ).toBe(5);
    await expect
      .poll(
        () =>
          Number(
            execUatSql(
              project,
              `SELECT count(*) FROM app.commitment_email_thread_judgements j JOIN app.email_messages e ON e.external_id=j.last_judged_external_id AND e.owner_user_id=j.owner_user_id WHERE j.owner_user_id='${UAT_ADMIN_ID}' AND j.outcome='no_item' AND e.subject IN ('Pharmacy pickup', 'Re: Design draft promise', 'Colleague report question')`
            )
          ),
        // Production defers thread judgement for three minutes after the last message.
        { timeout: 240_000, intervals: [1000, 2000, 4000] }
      )
      .toBe(3);
    expect(
      Number(
        execUatSql(
          project,
          `SELECT count(*) FROM app.commitment_candidates WHERE owner_user_id='${UAT_ADMIN_ID}'`
        )
      )
    ).toBe(0);
    console.log(
      "[live proof] five SMTP messages synced from real IMAP; inbound-only judgement saved no candidates"
    );
    const questionCategory = execUatSql(
      project,
      `SELECT signals->'actionability'->>'category' FROM app.email_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND subject='Colleague report question'`
    ).trim();
    console.log(`[live proof] colleague question triage category: ${questionCategory}`);
    expect.soft(questionCategory).toBe("needs_reply");
    const created = await page.request.post("/api/briefings/definitions", {
      data: {
        title: "One-sided notice proof",
        briefingType: "morning",
        cadence: "manual",
        enabled: true,
        scheduleMetadata: { targetTime: "07:00", timezone: "America/Los_Angeles" },
        selectedToolNames: ["commitments.listVisible", "email.listVisibleMessages"]
      }
    });
    expect(created.status()).toBe(201);
    const { definition } = await created.json();
    const started = await page.request.post(`/api/briefings/definitions/${definition.id}/run`, {
      data: {}
    });
    expect(started.status()).toBe(202);
    const { runId } = await started.json();
    let run:
      | {
          status: string;
          summaryText: string;
          sourceMetadata: {
            commitmentCount: number;
            emailCount: number;
            emailSignals: { type: string; messageIds: string[] }[];
            emailEvidence: {
              items: { messageId: string; status: string; reason: string; rank: number | null }[];
            };
          };
        }
      | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/briefings/definitions/${definition.id}/runs`
          );
          run = (await response.json()).runs.find((row: { id: string }) => row.id === runId);
          return run?.status;
        },
        { timeout: 180_000, intervals: [1000, 2000, 4000] }
      )
      .toBe("succeeded");
    const confirmationId = execUatSql(
      project,
      `SELECT external_id FROM app.email_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND subject='Your order is confirmed'`
    ).trim();
    expect
      .soft(
        run?.sourceMetadata.emailEvidence.items.find((item) => item.messageId === confirmationId)
      )
      .toMatchObject({ status: "informational", reason: "no_action_confirmation", rank: null });
    const questionId = execUatSql(
      project,
      `SELECT external_id FROM app.email_messages WHERE owner_user_id='${UAT_ADMIN_ID}' AND subject='Colleague report question'`
    ).trim();
    const questionEvidence = run?.sourceMetadata.emailEvidence.items.find(
      (item) => item.messageId === questionId
    );
    const questionSignal = run?.sourceMetadata.emailSignals.some(
      (signal) => signal.type === "needs_reply" && signal.messageIds.includes(questionId)
    );
    console.log(
      `[live proof] question selection: status=${questionEvidence?.status}, rank=${questionEvidence?.rank}, needs-reply signal=${questionSignal}`
    );
    expect.soft(questionEvidence?.status).toBe("reported_today");
    expect.soft(questionSignal).toBe(true);
    expect(run?.sourceMetadata.commitmentCount).toBe(1);
    expect(run?.sourceMetadata.emailCount).toBeGreaterThan(0);
    expect(run?.summaryText).toMatch(/design draft/i);
    expect(run?.summaryText).not.toMatch(/pharmacy|prescription|pick.?up/i);
    expect(run?.summaryText).not.toMatch(/order.*confirm|confirmation #1234/i);
    await page.reload();
    const hero = page.locator(".today-hero");
    await expect(
      hero.getByRole("button", { name: "Read the full morning briefing" })
    ).toBeVisible();
    await hero.getByRole("button", { name: "Read the full morning briefing" }).click();
    await expect(page.getByText(/design draft/i).first()).toBeVisible();
    await expect(page.getByText(/report/i).first()).toBeVisible();
    await expect(page.getByText("Your order is confirmed", { exact: false })).toHaveCount(0);
    console.log(
      "[live proof] real-Claude briefing kept the owner promise and omitted the pharmacy notice and no-action order confirmation on Today"
    );
  } finally {
    if (greenmail) execFileSync("docker", ["rm", "--force", greenmail]);
  }
});
