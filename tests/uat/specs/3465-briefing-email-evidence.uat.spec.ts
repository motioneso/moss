import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { assertUnknownPaymentStatus } from "../briefing-email-status.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

// Disclosed fixture: an unreachable IMAP endpoint exercises the production cache fallback.
// All synthetic messages are persisted through owner-scoped repositories; no response interception.
function seedMail(): void {
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Disposable stack required");
  const script = `
    const { ConnectorsRepository, createConnectorSecretCipher } = await import("/app/packages/connectors/src/index.ts");
    const { EmailRepository } = await import("/app/packages/email/src/repository.ts");
    const { createAppRuntimeRunner } = await import("/app/tests/uat/seed/connections.ts");
    const runner = createAppRuntimeRunner();
    try {
      await runner.withDataContext({ actorUserId: ${JSON.stringify(UAT_ADMIN_ID)} }, async db => {
        const connectors = new ConnectorsRepository();
        const cipher = createConnectorSecretCipher();
        const account = await connectors.createAccount(db, { providerId: "imap-fastmail", scopes: ["email.read"], encryptedSecret: cipher.encryptJson({ kind: "imap-password", providerId: "imap-fastmail", username: "fixture@example.test", password: "synthetic-fixture", imapHost: "127.0.0.1", imapPort: 1, imapTls: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecurity: "none" }) });
        const repo = new EmailRepository();
        const now = Date.now();
        for (let i = 0; i < 3; i++) {
          await repo.upsertCachedMessage(db, { connectorAccountId: account.id, sender: "Vendor" + i + " <vendor" + i + "@example.test>", subject: "Invoice #UAT" + i + " due last month", summary: "Invoice #UAT" + i + " was due last month.", receivedAt: new Date(now - 40 * 86400000), externalId: "bill-" + i, signals: { pendingJudgement: true, actionability: { category: "fyi" } } });
          await repo.upsertCachedMessage(db, { connectorAccountId: account.id, sender: "Vendor" + i + " <vendor" + i + "@example.test>", subject: "Invoice #UAT" + i + " paid in full", summary: "Invoice #UAT" + i + " paid in full.", receivedAt: new Date(now - 25 * 86400000), externalId: "receipt-" + i, signals: { actionability: { category: "receipt_or_notice" } } });
        }
        await repo.upsertCachedMessage(db, { connectorAccountId: account.id, sender: "VendorToday", subject: "Invoice #TODAY", summary: "Invoice #TODAY arrived today.", receivedAt: new Date(now), externalId: "today-bill", signals: { actionability: { category: "needs_action" } } });
        await repo.upsertCachedMessage(db, { connectorAccountId: account.id, sender: "Dana <dana@example.test>", subject: "Draft feedback", summary: "Dana asked for a reply about the draft.", receivedAt: new Date(now - 10 * 86400000), externalId: "colleague", signals: { actionability: { category: "needs_reply", inferredSubject: "Draft feedback", suggestedTasks: [{ title: "Reply about draft", dueDate: null }] } } });
      });
    } finally { await runner.destroy(); }
  `;
  execFileSync(
    "docker",
    buildUatComposeArgs(project, [
      "exec",
      "-T",
      "jarv1s",
      "node_modules/.bin/tsx",
      "--eval",
      `(async () => { ${script} })().catch(() => { console.error("Synthetic mail seed failed"); process.exit(1); });`
    ]),
    { stdio: "pipe", timeout: 60_000 }
  );
}

test.beforeAll(() => seedMail());

for (const briefingType of ["morning", "evening"] as const) {
  test(`real ${briefingType} writer reports current bills without unpaid claims (#3465)`, async ({
    page
  }) => {
    test.skip(!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "A real model is required");
    test.setTimeout(360_000);
    await signInUatAdmin(page);
    await bringUpRealChatModel(page);
    const locale = await page.request.put("/api/me/locale", {
      data: { locale: { timezone: "America/Los_Angeles", region: "en-US", dateFormat: "12" } }
    });
    expect(locale.ok()).toBe(true);
    expect(
      (
        await page.request.post("/api/tasks", {
          data: {
            title: "Emissions check",
            dueAt: new Date(Date.now() - 2 * 86400000).toISOString()
          }
        })
      ).status()
    ).toBe(201);
    const created = await page.request.post("/api/briefings/definitions", {
      data: {
        title: `Email ${briefingType} status proof`,
        briefingType,
        enabled: true,
        selectedToolNames: ["tasks.list", "email.listVisibleMessages"]
      }
    });
    expect(created.status()).toBe(201);
    const definitionId = (await created.json()).definition.id as string;

    // Start generation through the real chat UI and the normal briefing tool.
    await page.goto("/today");
    await page.getByRole("button", { name: "Chat with Moss" }).click();
    const chat = page.getByRole("dialog", { name: "Chat with Moss" });
    const input = chat.getByRole("textbox", { name: "Message Moss" });
    await input.fill(
      `Please re-run my ${briefingType} briefing now. Use your Moss briefing tools, not the shell.`
    );
    await input.press("Enter");
    await expect(chat.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 30_000
    });
    await expect(chat.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 180_000 });

    let run: { summaryText: string; sourceMetadata: Record<string, unknown> } | undefined;
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/briefings/definitions/${definitionId}/runs`
          );
          expect(response.ok()).toBe(true);
          run = (await response.json()).runs[0];
          return (
            run?.sourceMetadata.aiModel !== null && run?.sourceMetadata.emailEvidence !== undefined
          );
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] }
      )
      .toBe(true);
    const evidence = run!.sourceMetadata.emailEvidence as {
      items: Array<{
        messageId: string;
        status: string;
        contraryMessageIds: string[];
        rank: number | null;
      }>;
    };
    for (let i = 0; i < 3; i++) {
      expect(evidence.items.find((item) => item.messageId === `bill-${i}`)).toMatchObject({
        status: "settled",
        contraryMessageIds: [`receipt-${i}`],
        rank: null
      });
    }
    expect(evidence.items.find((item) => item.messageId === "colleague")).toMatchObject({
      status: "current_status_unknown",
      rank: null
    });
    expect(run!.sourceMetadata.emailSignals).toEqual([]);
    expect(evidence.items.find((item) => item.messageId === "today-bill")).toMatchObject({
      status: "current_status_unknown",
      rank: null
    });
    expect(run!.summaryText).not.toMatch(/Invoice #UAT|seriously overdue bills/i);
    expect(run!.summaryText).toMatch(/Invoice #TODAY|VendorToday/i);
    const billSentences = run!.summaryText
      .split(/\n|(?<=[.!?])\s+/)
      .filter((line) => /Invoice #TODAY|VendorToday|payment|bill/i.test(line))
      .join(" ");
    assertUnknownPaymentStatus(billSentences);
    if (briefingType === "evening") expect(run!.summaryText).not.toMatch(/Dana|draft feedback/i);
    expect(run!.summaryText).toMatch(/Emissions/i);
    if (briefingType === "morning" && /Dana|draft|reply/i.test(run!.summaryText)) {
      expect(run!.summaryText).toMatch(
        /unknown|unclear|unconfirmed|not confirmed|does not show.*payment status|status (?:is )?not known/i
      );
      expect(run!.summaryText).not.toMatch(/urgent|reply today|overdue reply/i);
    }
    await page.goto("/today");
    await page.getByRole("button", { name: `Read the full ${briefingType} briefing` }).click();
    const reader = page.getByRole("dialog");
    await expect(reader).toContainText(/Emissions/i);
    await expect(reader).not.toContainText(/Invoice #UAT|seriously overdue bills/i);
    console.log(
      `[3465 proof] real ${briefingType} writer and Today reader; 3 old invoices settled; today bill dated with unknown payment status; evening excludes historical replies; accepted task retained`
    );
  });
}
