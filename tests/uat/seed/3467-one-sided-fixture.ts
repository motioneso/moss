import assert from "node:assert/strict";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { EmailRepository } from "@moss/email";
import { createEmailThreadProvider } from "../../../packages/email/src/thread-provider.js";
import { CommitmentsRepository } from "@moss/commitments";
import { judgeEmailThread } from "../../../packages/commitments/src/email-judgement-worker.js";
import { CommitmentsRepository as OwnerCommitmentsRepository } from "@moss/structured-state";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "./connections.js";
import { assertTargetIsEphemeral } from "./guard.js";
import { UAT_ADMIN_ID, UAT_ADMIN_EMAIL } from "./admin.js";

// Runs only inside the disposable UAT stack; seed through owner-scoped public repositories.
async function main() {
  assert.equal(process.env.JARVIS_UAT_SEED_CONFIRM, "1");
  const check = createMigrationOwnerDb();
  try {
    await assertTargetIsEphemeral(check);
  } finally {
    await check.destroy();
  }
  const runner = createAppRuntimeRunner();
  try {
    const result = await runner.withDataContext({ actorUserId: UAT_ADMIN_ID }, async (db) => {
      const account = await new ConnectorsRepository().createAccount(db, {
        providerId: "google",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        encryptedSecret: createConnectorSecretCipher().encryptJson({ cli: true })
      });
      const email = new EmailRepository();
      const repository = new CommitmentsRepository();
      const now = new Date();
      for (const [externalId, subject, text, category] of [
        [
          "notice-3467",
          "Pharmacy pickup",
          "Your prescription is ready. Pick it up by Friday.",
          "receipt_or_notice"
        ],
        [
          "question-3467",
          "Colleague report question",
          "Could you send the report by Friday?",
          "needs_reply"
        ]
      ]) {
        const signals = {
          pendingJudgement: true,
          importance: "normal",
          confidence: 0.9,
          actionability: {
            category,
            inferredSubject: subject,
            suggestedTasks:
              category === "needs_reply"
                ? [{ title: "Reply to the colleague report question", dueDate: null }]
                : []
          }
        };
        const message = await email.upsertCachedMessage(db, {
          connectorAccountId: account.id,
          sender: "colleague@example.test",
          recipients: [UAT_ADMIN_EMAIL],
          subject: subject!,
          bodyExcerpt: text,
          snippet: text,
          summary: text,
          receivedAt: now,
          externalId: externalId!,
          externalMetadata: { threadId: externalId },
          signals
        });
        const outcome = await judgeEmailThread(
          db,
          { actorUserId: UAT_ADMIN_ID, threadRef: externalId!, idempotencyKey: externalId! },
          {
            repository,
            threads: createEmailThreadProvider(email, async () => new Set([UAT_ADMIN_EMAIL])),
            context: {},
            generate: async () => {
              throw new Error("Inbound-only threads must never reach generation");
            }
          }
        );
        assert.equal(outcome, "no_item");
        const saved = await email.getByOwnerAndExternalId(db, UAT_ADMIN_ID, externalId!);
        assert.deepEqual(saved?.signals, signals);
        assert.equal(saved?.id, message.id);
      }
      assert.equal((await repository.listCandidates(db, UAT_ADMIN_ID)).length, 0);
      const commitment = await new OwnerCommitmentsRepository().create(db, {
        title: "Send the promised design draft",
        provenance: "volunteered",
        sourceKind: "manual",
        counterparty: "Design team",
        dueAt: new Date(Date.now() + 3_600_000)
      });
      return {
        accountId: account.id,
        commitmentId: commitment.id,
        noticesPromoted: 0,
        questionTriage: "needs_reply"
      };
    });
    console.log(JSON.stringify(result));
  } finally {
    await runner.destroy();
  }
}
await main();
