import type { ModuleAiTaskDeclaration } from "@moss/module-sdk";

const TASK_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TASK_KEYS = new Set(["id", "label", "defaultTier", "requires"]);

function isTaskRequirements(value: unknown): value is readonly "vision"[] {
  return (
    Array.isArray(value) &&
    value.every((capability) => capability === "vision") &&
    new Set(value).size === value.length
  );
}

/** Validate and reconstruct the optional, metadata-only structured-AI task declarations. */
export function validateAiTasks(
  raw: unknown,
  errors: string[]
): readonly ModuleAiTaskDeclaration[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) {
    errors.push("aiTasks must be a non-empty array of at most 16 entries");
    return undefined;
  }

  const initialErrorCount = errors.length;
  const tasks: ModuleAiTaskDeclaration[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const path = `aiTasks[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    const block = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(block).filter((key) => !TASK_KEYS.has(key));
    if (unknownKeys.length > 0) {
      errors.push(`${path} contains unknown fields: ${unknownKeys.join(", ")}`);
    }
    const { id, label, defaultTier, requires } = block;
    if (typeof id !== "string" || id.trim() !== id || !TASK_ID_RE.test(id)) {
      errors.push(`${path}.id must be a lowercase slug starting with a letter (max 32 chars)`);
      continue;
    }
    if (ids.has(id)) errors.push(`${path}.id must be unique`);
    ids.add(id);
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 48) {
      errors.push(`${path}.label must be a non-empty string (max 48 chars)`);
      continue;
    }
    if (defaultTier !== "reasoning" && defaultTier !== "interactive" && defaultTier !== "economy") {
      errors.push(`${path}.defaultTier must be reasoning, interactive, or economy`);
      continue;
    }
    if (requires !== undefined && !isTaskRequirements(requires)) {
      errors.push(`${path}.requires must be a unique subset of ["vision"]`);
      continue;
    }
    tasks.push({
      id,
      label,
      defaultTier,
      ...(requires !== undefined ? { requires: [...requires] } : {})
    });
  }
  return errors.length === initialErrorCount ? tasks : undefined;
}
