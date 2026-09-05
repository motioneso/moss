/**
 * Re-judge recently received email.
 *
 * The triage rules live in the model's instructions, so changing them only affects mail that
 * arrives afterwards: a message already carrying a stored verdict is skipped by the next sync
 * as unchanged, and keeps whatever it was flagged as. This script empties the stored analysis
 * on the actor's recent messages and asks for a sync, which sends them back through the model
 * under the current rules.
 *
 * Usage: tsx scripts/rejudge-email.ts <userId> [--days 14]
 *
 * Nothing but the summary and signals columns is touched. The queued job carries only the actor
 * id, the job kind and an idempotency key.
 *
 * If a Google sync chain is already in flight the script clears as usual but does not queue a
 * sync, and says so: the running chain will not revisit pages it has already walked, and the
 * sync queue keeps one run per actor, so a job queued behind it finishes having done nothing
 * (observed on dev, #2271 round 3). Re-judging then happens on the next sync after this one.
 */
import { randomUUID } from "node:crypto";

import { ConnectorsRepository, planRejudgeSync } from "@moss/connectors";
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { EmailRepository } from "@moss/email";
import { createPgBossClient, sendJob } from "@moss/jobs";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 30;
const GOOGLE_SYNC_QUEUE = "connectors.google-sync";

function parseDays(argv: readonly string[]): number {
  const index = argv.indexOf("--days");
  if (index < 0) return DEFAULT_DAYS;
  const days = Number(argv[index + 1]);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    // The sync only refetches the last 30 days, so a longer window would clear rows that no
    // sync would ever come back for, leaving them blank instead of re-judged.
    throw new Error(`--days must be a whole number between 1 and ${MAX_DAYS}`);
  }
  return days;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const userId = argv[0];
  if (!userId || userId.startsWith("--")) {
    throw new Error("Usage: tsx scripts/rejudge-email.ts <userId> [--days 14]");
  }
  const days = parseDays(argv);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const urls = getMossDatabaseUrls();
  const appDb = createDatabase({ connectionString: urls.app, maxConnections: 1 });
  const dataContext = new DataContextRunner(appDb);
  const boss = createPgBossClient(urls.app);

  try {
    const { cleared, plan } = await dataContext.withDataContext(
      { actorUserId: userId, requestId: randomUUID() },
      async (scopedDb) => {
        const accounts = await new ConnectorsRepository().listAccounts(scopedDb);
        return {
          cleared: await new EmailRepository().clearRecentTriage(scopedDb, since),
          plan: planRejudgeSync(accounts, new Date())
        };
      }
    );
    console.log(
      `Cleared the stored verdict on ${cleared} message(s) received since ${since.toISOString()}.`
    );

    if (plan.queueSync) {
      await boss.start();
      await sendJob(
        boss,
        GOOGLE_SYNC_QUEUE,
        { actorUserId: userId, kind: "google-sync" as const, idempotencyKey: randomUUID() },
        { singletonKey: userId }
      );
    }
    console.log(plan.message);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await appDb.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
