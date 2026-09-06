import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { StubEmbeddingProvider } from "@moss/memory";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { createExternalModuleRpcHandler } from "@moss/module-registry/node";
import { VaultContextRunner } from "@moss/vault";

import { ChatAttachmentsService } from "../../packages/chat/src/attachments-service.js";

describe("external worker attachments.readText port (#1194)", () => {
  let vaultBase: string;
  let service: ChatAttachmentsService;
  const ownerUserId = randomUUID();
  const otherUserId = randomUUID();
  const module = {
    id: "job-search",
    dir: "/unused",
    manifest: {
      schemaVersion: 1,
      id: "job-search",
      name: "Job Search",
      version: "1.0.0",
      publisher: "Jarvis",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" }
    },
    manifestHash: "sha256:a",
    packageHash: "sha256:a"
  } satisfies ExternalModuleDiscovery;

  beforeAll(async () => {
    vaultBase = await mkdtemp(join(tmpdir(), "jarvis-module-attachment-"));
    service = new ChatAttachmentsService(new VaultContextRunner(vaultBase));
  });

  afterAll(async () => rm(vaultBase, { recursive: true, force: true }));

  const rpcFor = (
    actorUserId: string,
    readAttachmentText: Parameters<
      typeof createExternalModuleRpcHandler
    >[0]["readAttachmentText"] = async (access, attachmentId) => {
      const content = await service.readContent(access, attachmentId);
      return content.kind === "text"
        ? {
            fileName: content.meta.fileName,
            mimeType: content.meta.mimeType,
            text: content.text
          }
        : null;
    }
  ) =>
    createExternalModuleRpcHandler({
      module,
      toolRisk: "write",
      actorUserId,
      requestId: randomUUID(),
      workerDataContext: null as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider(),
      readAttachmentText
    });

  it("returns owner text and denies a non-owner attachment id", async () => {
    const attachment = await service.saveAttachment(
      { actorUserId: ownerUserId, requestId: randomUUID() },
      { fileName: "resume.txt", mimeType: "text/plain", bytes: Buffer.from("private resume") }
    );

    await expect(
      rpcFor(ownerUserId)("attachments.readText", { attachmentId: attachment.id }, () => undefined)
    ).resolves.toEqual({
      fileName: "resume.txt",
      mimeType: "text/plain",
      text: "private resume"
    });
    await expect(
      rpcFor(otherUserId)("attachments.readText", { attachmentId: attachment.id }, () => undefined)
    ).resolves.toBeNull();
  });

  it("fails closed for unavailable, invalid, failed, and non-text reads", async () => {
    const image = await service.saveAttachment(
      { actorUserId: ownerUserId, requestId: randomUUID() },
      {
        fileName: "avatar.png",
        mimeType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47])
      }
    );
    const call = (rpc: ReturnType<typeof createExternalModuleRpcHandler>, attachmentId: string) =>
      rpc("attachments.readText", { attachmentId }, () => undefined);

    const unavailable = createExternalModuleRpcHandler({
      module,
      toolRisk: "write",
      actorUserId: ownerUserId,
      requestId: randomUUID(),
      workerDataContext: null as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });

    await expect(call(unavailable, image.id)).resolves.toBeNull();
    await expect(call(rpcFor(ownerUserId), "not-a-uuid")).resolves.toBeNull();
    await expect(
      call(
        rpcFor(ownerUserId, async () => {
          throw new Error("vault unavailable");
        }),
        image.id
      )
    ).resolves.toBeNull();
    await expect(call(rpcFor(ownerUserId), image.id)).resolves.toBeNull();
  });
});
