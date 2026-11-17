// Writes a card and feedback with the real TypeScript repositories, lets the Rust port read and
// extend them, then checks that TypeScript reads the Rust rows back exactly as it would its own.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { CardRepository, serializeCard } from "../../../packages/proactive-monitoring/src/index.js";
import {
  UsefulnessFeedbackRepository,
  compileStoryRelevanceRule
} from "../../../packages/usefulness-feedback/src/index.js";
import { serializeFeedback } from "../../../packages/usefulness-feedback/src/feedback-response.js";
import { usefulnessFeedbackSignalsQuery } from "../../../packages/settings/src/data-export-queries.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
const app = createDatabase({ connectionString: urls.app });
const user = randomUUID();
const folder = mkdtempSync(join(tmpdir(), "proactive-feedback-"));
const out = join(folder, "rust-output.json");
let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console[ok ? "log" : "error"](`${ok ? "PASS" : "FAIL"}: ${name}`, ok ? "" : JSON.stringify(detail));
  if (!ok) failed = true;
};
try {
  await bootstrap.connect();
  await bootstrap.query("INSERT INTO app.users(id,email,name) VALUES($1,$2,'Feedback oracle')", [
    user,
    `feedback-oracle-${user}@example.test`
  ]);
  const runner = new DataContextRunner(app);
  const cards = new CardRepository();
  const repository = new UsefulnessFeedbackRepository();
  const { card, noted } = await runner.withDataContext({ actorUserId: user }, async (scope) => {
    const card = await cards.upsertCard(scope, {
      ownerUserId: user,
      source: "tasks",
      stableKey: "oracle-card",
      sourceRefHash: "hash-oracle",
      title: "Oracle card",
      summary: "A card the old server wrote",
      signalType: "task_due",
      priorityBand: "high",
      priorityReasons: ["due soon"],
      targetAt: "2026-12-01T10:00:00.000Z"
    });
    const noted = await repository.create(scope, {
      ownerUserId: user,
      targetKind: "proactive_card",
      targetRef: card.id,
      surface: "today",
      kind: "not_useful",
      verification: {
        ownerUserId: user,
        targetKind: "proactive_card",
        targetRef: card.id,
        surface: "today",
        sourceKind: "tasks",
        sourceLabel: "Tasks",
        priorityBand: "high",
        canRemember: false
      },
      metadata: {}
    });
    await repository.upsertTarget(scope, {
      ownerUserId: user,
      targetKind: "news_story",
      targetRef: "ts-story",
      surface: "news",
      sourceKind: "news",
      sourceLabel: "News",
      metadata: { topicRef: "topic-ts" }
    });
    return { card, noted };
  });
  const expected = {
    cards: [serializeCard(card)],
    feedback: [serializeFeedback(noted)]
  };

  const run = spawnSync(
    "cargo",
    [
      "+1.95.0",
      "test",
      "--locked",
      "--offline",
      "--manifest-path",
      "rust-spike/module-host/Cargo.toml",
      "--test",
      "proactive_feedback_database",
      "--",
      "--include-ignored",
      "--nocapture",
      "--test-threads=1"
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        JS43_APP_URL: urls.app,
        JS43_BOOTSTRAP_URL: urls.bootstrap,
        PF_TS_USER: user,
        PF_TS_CARD: card.id,
        PF_OUT: out
      }
    }
  );
  if (run.status !== 0) failed = true;
  else {
    const rust = JSON.parse(readFileSync(out, "utf8"));
    check("Rust lists the old card exactly as TypeScript serializes it", isDeepStrictEqual(rust.cards, expected.cards), { rust: rust.cards, expected: expected.cards });
    check("Rust lists the old feedback exactly as TypeScript serializes it", isDeepStrictEqual(rust.feedback, expected.feedback), { rust: rust.feedback, expected: expected.feedback });
    await runner.withDataContext({ actorUserId: user }, async (scope) => {
      for (const created of [rust.createdStory, rust.createdDismiss]) {
        const row = await repository.findOwned(scope, user, created.id);
        check(`TypeScript reads the Rust ${created.kind} row as Rust returned it`, row !== undefined && isDeepStrictEqual(serializeFeedback(row), created), { row, created });
        if (created.targetKind === "news_story" && row) {
          const rule = compileStoryRelevanceRule({
            moduleId: "news",
            direction: "less",
            storyRef: "ts-story",
            context: { topicRef: "topic-ts" },
            reasonText: "Fewer repeats of this please"
          });
          check("the Rust rule equals the TypeScript rule", isDeepStrictEqual(row.rule_json, rule), { rule, stored: row.rule_json });
        }
      }
      const dismissed = await cards.findById(scope, user, card.id);
      check("the Rust dismissal is read by TypeScript as a dismissed card", dismissed?.status === "dismissed", dismissed);
    });
    const exported = await runner.withDataContext({ actorUserId: user }, async (scope) => {
      const result = await usefulnessFeedbackSignalsQuery(user).execute(scope.db);
      return result.rows.map((row) => String(row.id));
    });
    check(
      "the old account export lists the Rust feedback rows",
      [rust.createdStory.id, rust.createdDismiss.id].every((id: string) => exported.includes(id)),
      exported
    );
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await bootstrap.query("DELETE FROM app.users WHERE id=$1", [user]).catch(() => undefined);
  rmSync(folder, { recursive: true, force: true });
  await Promise.allSettled([bootstrap.end(), app.destroy()]);
}
