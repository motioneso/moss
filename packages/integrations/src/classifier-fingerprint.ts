import { createHash } from "node:crypto";

import type { IntegrationToolDescriptor } from "@moss/shared";

/** Recursively sort object keys so JSON.stringify is canonical (order-independent). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    // Null prototype: a schema key named `__proto__` is hashed instead of dropped by the setter.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical fingerprint of one discovered tool's definition and the annotations that decide how
 * the classifier may offer it: name, description, group, input schema and the read/idempotent/
 * destructive hints. Absent hints stay distinct from explicit `false` (the shared descriptor's
 * "did not say" rule), so clearing a hint changes the digest. The invoke recipe and credentials
 * are excluded: they are not part of what the classifier sees, and folding them in would stale
 * every review on a harmless route refactor.
 *
 * The digest is the token a save compares against, and the source of truth for "stale".
 */
export function toolDefinitionFingerprint(tool: IntegrationToolDescriptor): string {
  const canonical = JSON.stringify(
    canonicalize({
      name: tool.name,
      description: tool.description,
      group: tool.group,
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly ?? null,
      idempotent: tool.idempotent ?? null,
      destructive: tool.destructive ?? null
    })
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
