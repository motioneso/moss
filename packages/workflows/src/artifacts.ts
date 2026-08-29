import { createHash, randomUUID } from "node:crypto";

import { readVaultFileBytes, writeVaultFileBytes } from "@moss/vault";
import type { VaultContextRunner } from "@moss/vault";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { WorkflowArtifactPort } from "@moss/module-sdk";
import type { WorkflowsRepository } from "./repository.js";

const MAX_CONTENT_TYPE_LENGTH = 200;

export interface WorkflowArtifactPortInput {
  readonly ownerUserId: string;
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly dataContext: DataContextRunner;
  readonly vaultRunner: VaultContextRunner;
  readonly repository: WorkflowsRepository;
}

export function createWorkflowArtifactPort(input: WorkflowArtifactPortInput): WorkflowArtifactPort {
  const accessContext: AccessContext = {
    actorUserId: input.ownerUserId,
    requestId: `workflow-artifact:${input.workflowRunId}:${input.stepRunId}`
  };

  return {
    async write(value) {
      if (value.workflowRunId !== input.workflowRunId || value.stepRunId !== input.stepRunId) {
        throw new Error("Workflow artifact ids do not match the active step");
      }
      if (!value.contentType || value.contentType.length > MAX_CONTENT_TYPE_LENGTH) {
        throw new Error("Workflow artifact content type is invalid");
      }

      const bytes = Buffer.from(value.bytes);
      const artifactRef = `workflows/${input.workflowRunId}/${randomUUID()}`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await input.vaultRunner.withVaultContext(accessContext, (ctx) =>
        writeVaultFileBytes(ctx, artifactRef, bytes)
      );
      await input.dataContext.withDataContext(accessContext, (scopedDb) =>
        input.repository.recordArtifact(scopedDb, {
          workflowRunId: input.workflowRunId,
          stepRunId: input.stepRunId,
          ownerUserId: input.ownerUserId,
          artifactRef,
          sha256,
          contentType: value.contentType,
          sizeBytes: bytes.byteLength
        })
      );
      return { artifactRef, sha256, sizeBytes: bytes.byteLength };
    },

    async read(artifactRef) {
      const artifact = await input.dataContext.withDataContext(accessContext, (scopedDb) =>
        input.repository.getArtifact(
          scopedDb,
          input.ownerUserId,
          input.workflowRunId,
          input.stepRunId,
          artifactRef
        )
      );
      if (!artifact) throw new Error("Workflow artifact not found");

      const bytes = await input.vaultRunner.withVaultContext(accessContext, (ctx) =>
        readVaultFileBytes(ctx, artifact.artifactRef)
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== artifact.sha256 || bytes.byteLength !== artifact.sizeBytes) {
        throw new Error("Workflow artifact integrity check failed");
      }
      return { bytes, contentType: artifact.contentType };
    }
  };
}
