/**
 * Shadow comparison for email sorting on the sorting model (#2805).
 *
 * Re-sorts one user's already-sorted mail through the sorting-model path (five yes/no questions,
 * mapped to a category in code) and reports how often it agrees with the stored verdict. Nothing is
 * written: the stored verdict and every other column stay as they are.
 *
 * Usage: tsx scripts/compare-email-sorting.ts <userId> [--days 14] [--limit 200]
 *          [--out report.json] [--show-subjects]
 *
 * It runs inside the user's own data context, so row level security limits it to that user's mail.
 * The sorting model sees what the cache holds (subject, sender, dates and the stored excerpt), not
 * the full body a live sync sees. `--show-subjects` prints subjects of disagreements to this
 * terminal only; the report file carries ids, verdicts and answer probabilities, never content.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { AiRepository, askSortingProbabilities, createAiSecretCipher } from "@moss/ai";
import {
  EMAIL_SORTING_SERVICE,
  shadowSortEmail,
  storedVerdictOf,
  summarizeEmailSortingComparison,
  userSentLastInThread,
  type EmailSortingComparisonRow,
  type StoredEmailVerdict
} from "@moss/connectors";
import { DataContextRunner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { EmailRepository } from "@moss/email";
import { createCliStructuredAdapterFactory } from "@moss/module-registry";

const CONCURRENCY = 4;

function numberFlag(argv: readonly string[], name: string, fallback: number, max: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
  return value;
}

function stringFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

function bareAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1]! : value).trim().toLowerCase();
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const userId = argv[0];
  if (!userId || userId.startsWith("--")) {
    throw new Error(
      "Usage: tsx scripts/compare-email-sorting.ts <userId> [--days 14] [--limit 200] [--out file] [--show-subjects]"
    );
  }
  const days = numberFlag(argv, "--days", 14, 365);
  const limit = numberFlag(argv, "--limit", 200, 5_000);
  const out = stringFlag(argv, "--out");
  const showSubjects = argv.includes("--show-subjects");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const now = new Date();

  const urls = getMossDatabaseUrls();
  const appDb = createDatabase({ connectionString: urls.app, maxConnections: 2 });
  const dataContext = new DataContextRunner(appDb);
  const aiDeps = {
    repository: new AiRepository(),
    cipher: createAiSecretCipher(),
    createCliStructuredAdapter: createCliStructuredAdapterFactory()
  };
  const emails = new EmailRepository();

  try {
    const { rows, subjects, modelIds } = await dataContext.withDataContext(
      { actorUserId: userId, requestId: randomUUID() },
      async (scopedDb) => {
        const mine = new Set(
          (await emails.listFrequentRecipientAddresses(scopedDb, userId))
            .map(bareAddress)
            .filter((a) => a.length > 0)
        );
        const candidates: {
          message: Awaited<ReturnType<EmailRepository["listVisible"]>>[number];
          stored: StoredEmailVerdict;
        }[] = [];
        for (const message of await emails.listVisible(scopedDb)) {
          if (message.owner_user_id !== userId) continue;
          if (new Date(message.received_at) < since) continue;
          const stored = storedVerdictOf(message.signals);
          if (stored) candidates.push({ message, stored });
          if (candidates.length >= limit) break;
        }

        const threadCache = new Map<string, boolean>();
        const userSentLast = async (message: (typeof candidates)[number]["message"]) => {
          const metadata = message.external_metadata as Record<string, unknown> | null;
          const threadId = typeof metadata?.threadId === "string" ? metadata.threadId : null;
          if (!threadId)
            return userSentLastInThread(
              [{ sender: message.sender, receivedAt: message.received_at }],
              mine
            );
          const cached = threadCache.get(threadId);
          if (cached !== undefined) return cached;
          // listByThread returns the oldest messages up to a cap; add the newest one past them.
          const thread = await emails.listByThread(scopedDb, userId, threadId);
          const last = thread.at(-1);
          const newer = last
            ? await emails.listNewerInThreads(scopedDb, userId, [
                { threadId, afterExternalId: last.external_id }
              ])
            : [];
          const value = userSentLastInThread(
            [...thread, ...newer.map((n) => n.message)].map((m) => ({
              sender: m.sender,
              receivedAt: m.received_at
            })),
            mine
          );
          threadCache.set(threadId, value);
          return value;
        };

        const results: EmailSortingComparisonRow[] = [];
        const subjectById = new Map<string, string>();
        const models = new Set<string>();
        let next = 0;
        const runners = Array.from({ length: CONCURRENCY }, async () => {
          while (next < candidates.length) {
            const { message, stored } = candidates[next]!;
            next += 1;
            subjectById.set(message.id, message.subject);
            const shadow = await shadowSortEmail(
              {
                id: message.id,
                subject: message.subject,
                sender: message.sender,
                receivedAt: message.received_at,
                text: message.body_excerpt || message.snippet || "",
                signals: message.signals,
                userSentLast: await userSentLast(message)
              },
              async (state, questions) => {
                const result = await askSortingProbabilities(
                  scopedDb,
                  { service: EMAIL_SORTING_SERVICE, state, questions },
                  aiDeps
                );
                if (result.ok) models.add(result.modelId);
                return result;
              },
              now
            );
            results.push({ ...shadow, stored });
          }
        });
        await Promise.all(runners);
        return { rows: results, subjects: subjectById, modelIds: models };
      }
    );

    const summary = summarizeEmailSortingComparison(rows);
    const notSupported = rows.filter(
      (r) => r.shadow.kind === "failed" && r.shadow.error === "not_supported"
    ).length;
    console.log(`Compared ${rows.length} sorted message(s) received since ${since.toISOString()}.`);
    console.log(`Sorting model row(s) that answered: ${[...modelIds].join(", ") || "none"}`);
    if (notSupported > 0) {
      console.log(
        `${notSupported} message(s) had no sorting model to ask: none is bound, an admin pin is set, or email sorting has its own job binding.`
      );
    }
    console.log(
      `Agreement where the sorting model decided: ${summary.agreed}/${summary.decided} (${percent(summary.agreementRate)})`
    );
    console.log(`Unsure, would go to the general model: ${JSON.stringify(summary.unsure)}`);
    console.log(`Failed requests: ${summary.failed}`);
    console.log(
      `Held for a closer look today, sorting model would say: ${JSON.stringify(summary.pending)}`
    );
    console.log("Stored verdict -> sorting model category:");
    for (const [stored, row] of Object.entries(summary.confusion)) {
      console.log(`  ${stored}: ${JSON.stringify(row)}`);
    }
    console.log("Disagreements:");
    for (const row of summary.disagreements) {
      const shadow = row.shadow.kind === "category" ? row.shadow.category : row.shadow.kind;
      const answers = row.probabilities
        ? Object.entries(row.probabilities)
            .map(([id, p]) => `${id}=${(p ?? 0).toFixed(2)}`)
            .join(" ")
        : "";
      const subject = showSubjects ? `  "${subjects.get(row.id) ?? ""}"` : "";
      console.log(`  ${row.id}  ${row.stored} -> ${shadow}  ${answers}${subject}`);
    }
    if (out) {
      writeFileSync(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`, { mode: 0o600 });
      console.log(`Wrote ${out}`);
    }
  } finally {
    await appDb.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
