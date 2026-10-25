import type { ModuleParamsSchema } from "@moss/module-sdk";

/** Applies only after the canonical params-schema shape validator has accepted the schema. */
export function isMetadataOnlyEnqueueSchema(schema: ModuleParamsSchema): boolean {
  switch (schema.type) {
    case "string":
      return false;
    case "array":
      return isMetadataOnlyEnqueueSchema(schema.items);
    case "object":
      return Object.values(schema.fields).every(isMetadataOnlyEnqueueSchema);
    default:
      return true;
  }
}
