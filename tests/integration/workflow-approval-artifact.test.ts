import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { type Job, type PgBoss } from "@moss/jobs";
import { type ModuleWorkflowDefinition } from "@moss/module-sdk";
import { VaultContextRunner } from "@moss/vault";
import {
  createWorkflowArtifactPort,
  runWorkflowStep,
  WorkflowsRepository,
  type WorkflowStepJobPayload
} from "@moss/workflows";
import type { Kysely } from "kysely";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

const ownerUserId = ids.userA;
const otherUserId = ids.userB;

function job(jobId: string, workflowRunId: string, stepRunId: string): Job<WorkflowStepJobPayload> {
  return {
    id: jobId,
    data: { actorUserId: ownerUserId, workflowRunId, stepRunId }
  } as Job<WorkflowStepJobPayload>;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(db);
});

afterAll(async () => {
  await db?.destroy();
});

describe("workflow approval artifacts", () => {
  it("lets a task write and read Vault bytes while storing metadata only", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-workflow-artifact-"));
    try {
      const repo = new WorkflowsRepository();
      const vaultRunner = new VaultContextRunner(vaultRoot);
      const content = new TextEncoder().encode("private artifact");
      let readContent = "";
      const definition: ModuleWorkflowDefinition = {
        id: "workflows.artifact-port",
        displayName: "Artifact port workflow",
        version: 1,
        startStepId: "write",
        trigger: "manual",
        steps: [
          {
            id: "write",
            kind: "task",
            handler: async ({ artifacts, workflowRunId, stepRunId }) => {
              const written = await artifacts.write({
                workflowRunId,
                stepRunId,
                contentType: "text/plain",
                bytes: content
              });
              const read = await artifacts.read(written.artifactRef);
              readContent = new TextDecoder().decode(read.bytes);
              return { artifactRef: written.artifactRef, sha256: written.sha256 };
            }
          }
        ],
        edges: []
      };
      const boss = {
        send: async () => "artifact-job"
      } as unknown as PgBoss;
      const deps = {
        boss,
        dataContext,
        registry: new Map([[definition.id, { moduleId: "workflows", definition }]]),
        vaultRunner
      };
      const created = await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-artifact-test" },
        (scopedDb) =>
          repo.createRun(scopedDb, {
            ownerUserId,
            workflowId: definition.id,
            workflowVersion: definition.version,
            moduleId: "workflows",
            startedBy: "user",
            startStepId: definition.startStepId
          })
      );
      await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-artifact-test" },
        (scopedDb) => repo.setStepQueueJobId(scopedDb, created.firstStepRun.id, "artifact-job")
      );

      await runWorkflowStep(job("artifact-job", created.run.id, created.firstStepRun.id), deps);

      expect(readContent).toBe("private artifact");
      const artifacts = await dataContext.withDataContext(
        { actorUserId: ownerUserId, requestId: "workflow-artifact-test" },
        (scopedDb) => repo.listArtifacts(scopedDb, ownerUserId, created.run.id)
      );
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        workflowRunId: created.run.id,
        stepRunId: created.firstStepRun.id,
        contentType: "text/plain",
        sizeBytes: content.byteLength
      });
      expect(artifacts[0]?.artifactRef).toMatch(
        new RegExp(`^workflows/${created.run.id}/[0-9a-f-]+$`)
      );

      const ownerArtifact = artifacts[0]!;
      const otherOwnerPort = createWorkflowArtifactPort({
        ownerUserId: otherUserId,
        workflowRunId: created.run.id,
        stepRunId: created.firstStepRun.id,
        dataContext,
        vaultRunner,
        repository: repo
      });
      await expect(otherOwnerPort.read(ownerArtifact.artifactRef)).rejects.toThrow(
        "Workflow artifact not found"
      );
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
