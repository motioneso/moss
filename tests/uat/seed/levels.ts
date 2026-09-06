import { SharesRepository } from "@moss/db";
import { WorkflowsRepository } from "@moss/workflows";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "./connections.js";
import { seedSecondOwner, seedSoloAdmin } from "./admin.js";
import { seedOnboardingChunk } from "./chunks/onboarding.js";
import { seedActivityOutcomeFixture, seedAiProviderChunk } from "./chunks/ai.js";
import { seedScriptedChatProviderChunk } from "./chunks/chat-script.js";
import { seedJobSearchAiProviderChunk } from "./chunks/job-search-ai.js";
import { seedNewsChunk } from "./chunks/news.js";
import { seedSportsChunk, seedSportsPublicSourceFixtures } from "./chunks/sports.js";
import { seedTasksChunk } from "./chunks/tasks.js";
import { seedCalendarChunk } from "./chunks/calendar.js";
import { seedNotesChunk } from "./chunks/notes.js";
import { seedFinanceChunk } from "./chunks/finance.js";
import { installWorkshopStorageFixture } from "./chunks/workshop-storage.js";
import { UAT_SEED_BASE_TIMESTAMP } from "./timestamps.js";
import type { SeedOptions, UatSeedChunk } from "./types.js";

// #1025 spec §4.3: the level ladder is additive — this is the single source of
// truth for "which chunks exist at admin+data".
//
// #1087 finding 3: a chunk that INSTALLS a module must never join this default
// set. Per spec §4.4, "not installed" is the admin+data DEFAULT (it proves
// #1026's absent-module UI path), and a per-caller `excludeChunks` opt-out fails
// OPEN (silently installs) the moment any caller forgets to pass it. Data-only
// chunks are safe here; module-installing ones must be called explicitly by the
// one level composition that needs them.
//
// #1306/N33: job-search is the concrete instance of this rule — it gets NO chunk
// here, deliberately, not even a no-op. See the longer rationale beside
// UAT_SEED_CHUNKS in ./types.ts and rulings-ledger.md#n33.
const ADMIN_DATA_CHUNKS: ReadonlyArray<{
  key: UatSeedChunk;
  run: (runner: ReturnType<typeof createAppRuntimeRunner>, actorUserId: string) => Promise<void>;
}> = [
  { key: "news", run: (runner, actorUserId) => seedNewsChunk(runner, actorUserId) },
  { key: "sports", run: (runner, actorUserId) => seedSportsChunk(runner, actorUserId) },
  { key: "tasks", run: (runner, actorUserId) => seedTasksChunk(runner, actorUserId) },
  { key: "calendar", run: (runner, actorUserId) => seedCalendarChunk(runner, actorUserId) },
  { key: "notes", run: (runner, actorUserId) => seedNotesChunk(runner, actorUserId) },
  // FIN-02 (#1147): finance IS safe in the
  // always-on ladder — its chunk writes only user-scoped module_kv DATA rows and
  // never installs the module (no external_modules row), so the #1087/#1026
  // "not installed by default" ruling still holds; the rows are invisible until
  // a spec activates the module itself (the finance-feed spec's D7 docker-cp +
  // admin-enable flow).
  { key: "finance", run: (runner, actorUserId) => seedFinanceChunk(runner, actorUserId) }
];

async function seedDataChunks(
  runner: ReturnType<typeof createAppRuntimeRunner>,
  actorUserId: string,
  exclude: ReadonlySet<UatSeedChunk>
): Promise<void> {
  for (const chunk of ADMIN_DATA_CHUNKS) {
    if (exclude.has(chunk.key)) continue;
    await chunk.run(runner, actorUserId);
  }
}

export async function seedLevel(options: SeedOptions): Promise<void> {
  if (options.level === "bare") {
    return; // #1024/#1000: bare is the Phase 1 no-op — a migrated DB, nothing more.
  }

  const migrationDb = createMigrationOwnerDb();
  let adminUserId: string;
  let secondOwnerUserId: string | undefined;
  try {
    ({ userId: adminUserId } = await seedSoloAdmin(migrationDb));
    if (options.level === "multi-user") {
      ({ userId: secondOwnerUserId } = await seedSecondOwner(migrationDb));
    }
  } finally {
    await migrationDb.destroy();
  }

  if (options.chatScript) {
    const scriptedRunner = createAppRuntimeRunner();
    try {
      await seedScriptedChatProviderChunk(scriptedRunner, adminUserId);
    } finally {
      await scriptedRunner.destroy();
    }
  }

  if (options.activityOutcomeFixture) {
    const runner = createAppRuntimeRunner();
    try {
      await seedActivityOutcomeFixture(runner, adminUserId);
    } finally {
      await runner.destroy();
    }
  }

  if (options.workflowApprovalFixture) {
    const runner = createAppRuntimeRunner();
    try {
      await runner.withDataContext({ actorUserId: adminUserId }, async (scopedDb) => {
        const repo = new WorkflowsRepository();
        const { run, firstStepRun } = await repo.createRun(scopedDb, {
          ownerUserId: adminUserId,
          workflowId: "workflows.approval-continuation",
          workflowVersion: 1,
          moduleId: "uat",
          startedBy: "user",
          startStepId: "approval"
        });
        await repo.markRunRunning(scopedDb, run.id);
        await repo.createApproval(scopedDb, {
          workflowRunId: run.id,
          stepRunId: firstStepRun.id,
          ownerUserId: adminUserId,
          summary: "Approve the seeded workflow action"
        });
      });
    } finally {
      await runner.destroy();
    }
  }

  if (options.level === "solo-admin") {
    return;
  }

  // admin+data and multi-user both include every non-excluded chunk.
  const runner = createAppRuntimeRunner();
  try {
    const exclude = new Set(options.excludeChunks ?? []);
    // #1026: not excludable — every admin+data/multi-user instance must land on
    // AppShell, not the onboarding wizard, for any UI-driving spec to work at all.
    await seedOnboardingChunk(runner, adminUserId);
    // #1025: AI provider/model/binding must land before the news chunk, since
    // news settings check for an active module.news binding — order matters here,
    // it is not a parallelizable Promise.all.
    await seedAiProviderChunk(runner, adminUserId, {
      bindNews: options.withoutNewsJsonBinding !== true
    });
    // N42/#57: opt-in, absent by default — see SeedOptions.jobSearchAiProviderBaseUrl's doc
    // comment and ./chunks/job-search-ai.ts's header. Ordered with the other AI-binding call
    // above for the same reason (no downstream chunk depends on it either way today, but a
    // service binding should exist before anything that might check it).
    if (options.jobSearchAiProviderBaseUrl) {
      await seedJobSearchAiProviderChunk(runner, adminUserId, options.jobSearchAiProviderBaseUrl);
    }
    await seedDataChunks(runner, adminUserId, exclude);
    if (options.withWorkshopStorageFixture) {
      await installWorkshopStorageFixture(runner, adminUserId);
    }
    if (options.sportsPublicSourceFixtures) {
      await seedSportsPublicSourceFixtures(runner, adminUserId);
    }

    if (options.level === "multi-user") {
      if (secondOwnerUserId === undefined) {
        throw new Error("seedLevel: multi-user owner bootstrap did not return an id");
      }

      // #1087 finding 3: no module-installing chunk is in ADMIN_DATA_CHUNKS (see
      // above), so there is nothing instance-level to re-exclude here for the
      // second owner — `exclude` alone is already correct for seedDataChunks.
      //
      // FIN-04 (#1149): finance stays ADMIN-ONLY at multi-user. The shared-pool
      // UAT needs an asymmetric household — the chunk uses fixed account ids, so
      // seeding it for owner2 would give them identical accounts of their OWN and
      // make "member does NOT see the unshared account" unfalsifiable.
      await seedDataChunks(runner, secondOwnerUserId, new Set([...exclude, "finance"]));

      // SECURITY: grant under the resource owner's own context. The shares INSERT
      // policy rejects forged owner_user_id values; owner2 receives only this task.
      await runner.withDataContext({ actorUserId: adminUserId }, async (scopedDb) => {
        const sharedTask = await scopedDb.db
          .selectFrom("app.tasks")
          .select("id")
          .where("owner_user_id", "=", adminUserId)
          .where("source", "=", "uat-seed")
          .where("external_key", "=", "Draft Q1 planning doc")
          .executeTakeFirstOrThrow();

        await new SharesRepository().grant(scopedDb, {
          resourceType: "task",
          resourceId: sharedTask.id,
          ownerUserId: adminUserId,
          granteeUserId: secondOwnerUserId,
          level: "view",
          now: UAT_SEED_BASE_TIMESTAMP
        });
      });
    }
  } finally {
    await runner.destroy();
  }
}
