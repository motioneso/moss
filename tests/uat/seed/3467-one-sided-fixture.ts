import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { CommitmentsRepository } from "@moss/structured-state";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "./connections.js";
import { assertTargetIsEphemeral } from "./guard.js";
import { UAT_ADMIN_ID } from "./admin.js";

// The disposable mailbox receives real SMTP messages; sync and judgement run normally.
async function main() {
  assert.equal(process.env.JARVIS_UAT_SEED_CONFIRM, "1");
  const check = createMigrationOwnerDb();
  try {
    await assertTargetIsEphemeral(check);
  } finally {
    await check.destroy();
  }
  const require = createRequire(
    new URL("../../../packages/connectors/package.json", import.meta.url)
  );
  const transport = require("nodemailer").createTransport({
    host: "emailfixture",
    port: 3025,
    secure: false,
    ignoreTLS: true
  });
  const messages = [
    {
      from: "shop@example.test",
      subject: "Your order is confirmed",
      text: "Order confirmation #1234. Thank you for your purchase. No further action is required.",
      messageId: "<confirmation@fixture.test>"
    },
    {
      from: "pharmacy@example.test",
      subject: "Pharmacy pickup",
      text: "Your prescription is ready. Pick it up by Friday.",
      messageId: "<notice@fixture.test>"
    },
    {
      from: "probe@greenmail.test",
      subject: "Design draft promise",
      text: "I promise to send the design draft to the team today.",
      messageId: "<promise@fixture.test>"
    },
    {
      from: "designer@example.test",
      subject: "Re: Design draft promise",
      text: "Thanks for agreeing to send your design draft. We look forward to it today.",
      messageId: "<reply@fixture.test>",
      inReplyTo: "<promise@fixture.test>",
      references: "<promise@fixture.test>"
    },
    {
      from: "colleague@example.test",
      subject: "Colleague report question",
      text: "Could you send the report by Friday? Please reply today.",
      messageId: "<question@fixture.test>"
    }
  ];
  for (const message of messages)
    await transport.sendMail({ ...message, to: "probe@greenmail.test", date: new Date() });
  transport.close();
  const runner = createAppRuntimeRunner();
  try {
    const commitment = await runner.withDataContext({ actorUserId: UAT_ADMIN_ID }, (db) =>
      new CommitmentsRepository().create(db, {
        title: "Send the promised design draft",
        provenance: "volunteered",
        sourceKind: "manual",
        counterparty: "Design team",
        dueAt: new Date(Date.now() + 3_600_000)
      })
    );
    console.log(
      JSON.stringify({ commitmentId: commitment.id, messagesDelivered: messages.length })
    );
  } finally {
    await runner.destroy();
  }
}
await main();
