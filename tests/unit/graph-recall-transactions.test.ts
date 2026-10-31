import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb, type DataContextRunner } from "@moss/db";
import { GraphMemoryRecallService, type EmbeddingProvider } from "@moss/memory";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;

describe("GraphMemoryRecallService.recallWithDataContext", () => {
  it("embeds the query with no transaction open", async () => {
    let open = 0;
    const dataContext: Pick<DataContextRunner, "withDataContext"> = {
      withDataContext: async (_ctx, callback) => {
        open += 1;
        try {
          return await callback(scopedDb);
        } finally {
          open -= 1;
        }
      }
    };
    let openDuringEmbed = -1;
    const provider: EmbeddingProvider = {
      dimensions: 2,
      modelName: "test",
      modelVersion: "0",
      embedDocument: async () => [0, 0],
      embedQuery: async () => {
        openDuringEmbed = open;
        return [0.1, 0.2];
      }
    };
    let searched: number[] | null = null;
    const repository = {
      listFactRecallCandidates: async (_db: unknown, _owner: unknown, embedding: number[]) => {
        searched = embedding;
        return [];
      },
      getOtherSubjectNames: async () => new Map<string, string>()
    };
    const service = new GraphMemoryRecallService(provider, repository as never);

    const result = await service.recallWithDataContext(
      dataContext,
      "11111111-1111-4111-8111-111111111111",
      "house project",
      { limit: 8 }
    );

    expect(openDuringEmbed).toBe(0);
    expect(searched).toEqual([0.1, 0.2]);
    expect(result).toEqual({ query: "house project", items: [] });
  });
});
