import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { StubEmbeddingProvider } from "@moss/memory";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { createExternalModuleRpcHandler } from "@moss/module-registry/node";
import { EMBED_BATCH_MAX } from "@moss/module-sdk";

describe("external worker ctx.embed port (#1281)", () => {
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

  // The embed branches are served before withDataContext, so the null casts
  // below are never dereferenced — same harness shape as the attachments port
  // test, which relies on the identical property.
  const rpcFor = (provider: StubEmbeddingProvider) =>
    createExternalModuleRpcHandler({
      module,
      toolRisk: "write",
      actorUserId: randomUUID(),
      requestId: randomUUID(),
      workerDataContext: null as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      embeddingProvider: async () => provider
    });

  it("returns one document vector per input, in order", async () => {
    const provider = new StubEmbeddingProvider();
    const result = (await rpcFor(provider)(
      "embed.embedDocuments",
      { texts: ["senior platform engineer", "junior barista"] },
      () => undefined
    )) as { vectors: number[][] };

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(provider.dimensions);
    expect(result.vectors[1]).toHaveLength(provider.dimensions);
    // Distinct inputs must yield distinct vectors: a port that returns the
    // first vector for every input, or that loses order, passes a length check.
    expect(result.vectors[0]).not.toEqual(result.vectors[1]);
    await expect(
      rpcFor(provider)("embed.embedDocuments", { texts: ["junior barista"] }, () => undefined)
    ).resolves.toEqual({ vectors: [result.vectors[1]] });
  });

  it("routes a query through embedQuery and never through embedDocument", async () => {
    const provider = new StubEmbeddingProvider();
    const query = vi.spyOn(provider, "embedQuery");
    const document = vi.spyOn(provider, "embedDocument");

    const result = (await rpcFor(provider)(
      "embed.embedQuery",
      { text: "remote staff engineer" },
      () => undefined
    )) as { vector: number[] };

    expect(result.vector).toHaveLength(provider.dimensions);
    expect(query).toHaveBeenCalledWith("remote staff engineer");
    // The document path applies a different task prefix; reusing it here would
    // degrade retrieval with nothing visible failing.
    expect(document).not.toHaveBeenCalled();
  });

  it("reports the configured provider's dimensionality", async () => {
    const provider = new StubEmbeddingProvider();

    await expect(rpcFor(provider)("embed.dimensions", {}, () => undefined)).resolves.toEqual({
      dimensions: provider.dimensions
    });
  });

  it("rejects a batch over the cap without calling the provider", async () => {
    const provider = new StubEmbeddingProvider();
    const document = vi.spyOn(provider, "embedDocument");
    const texts = Array.from({ length: EMBED_BATCH_MAX + 1 }, (_, i) => `posting ${i}`);

    // Asserted on `detail`, never on `message`: the error's message is the bare
    // code, so a message regex could never pass.
    await expect(
      rpcFor(provider)("embed.embedDocuments", { texts }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc", detail: /at most 128/ });
    // The cap has to be a guard, not a post-hoc check on work already done.
    expect(document).not.toHaveBeenCalled();
  });

  it("rejects a non-string entry rather than embedding a coerced value", async () => {
    const provider = new StubEmbeddingProvider();

    await expect(
      rpcFor(provider)("embed.embedDocuments", { texts: ["ok", 7] }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc" });
  });
});
