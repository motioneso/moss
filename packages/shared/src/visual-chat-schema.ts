/** Serialization schema; the semantic validator remains mandatory before this boundary. */
export const visualReplySchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "catalogVersion", "blocks", "snapshots", "interactions", "fallbackText"],
  properties: {
    version: { type: "integer", const: 1 },
    catalogVersion: { type: "string" },
    blocks: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blockId", "kind", "snapshotRefs"],
        properties: {
          blockId: { type: "string" },
          kind: { type: "string" },
          snapshotRefs: { type: "array", items: { type: "string" }, maxItems: 4 },
          program: { type: "string", maxLength: 16384 }
        }
      }
    },
    snapshots: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "origin", "source", "retrievedAt", "coverage", "fields"],
        properties: {
          ref: { type: "string" },
          kind: { type: "string" },
          origin: { type: "string" },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label"],
            properties: { id: { type: "string" }, label: { type: "string" } }
          },
          retrievedAt: { type: "string" },
          coverage: { type: "string" },
          revision: { type: "string" },
          fields: { type: "object", additionalProperties: true }
        }
      }
    },
    // This catalog has no controls. Later catalogs must explicitly extend this contract.
    interactions: { type: "array", maxItems: 0 },
    fallbackText: { type: "string", maxLength: 4000 }
  }
} as const;
