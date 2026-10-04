import { describe, expect, it } from "vitest";

import { mapEmbeddingActivityEntry } from "../../packages/module-registry/src/embedding-activity.js";

describe("embedding forward to the activity log (#2956 slice B)", () => {
  it("maps the source onto the embed line code and keeps the owner", () => {
    expect(
      mapEmbeddingActivityEntry({
        kind: "embedding",
        action: "embedding",
        outcome: "ok",
        modelName: "embed-model",
        result: "completed",
        source: "notes",
        ownerUserId: "user-1"
      })
    ).toEqual({
      kind: "embedding",
      action: "embedding",
      outcome: "ok",
      modelName: "embed-model",
      result: "completed",
      actionCode: "embed.notes",
      ownerUserId: "user-1"
    });
  });

  it("leaves a sourceless line uncoded rather than inventing a source", () => {
    const mapped = mapEmbeddingActivityEntry({
      kind: "embedding",
      action: "embedding",
      outcome: "ok",
      modelName: "embed-model",
      result: "completed"
    });
    expect(mapped).not.toHaveProperty("actionCode");
    expect(mapped).not.toHaveProperty("source");
  });
});
