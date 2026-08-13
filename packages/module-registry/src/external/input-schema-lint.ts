import { compilePattern } from "@moss/ai/gateway/input-validation";

// Trust-boundary lint (#1274): an external module's declared inputSchema.pattern must compile
// the same way compilePattern requires at call time, or every future call to that tool fails
// closed anyway — better to reject the manifest at install time than let it look accepted.
// Bounded to depth 12 against a pathological nested schema; a pattern nested deeper than that is
// unlinted here but still fails closed at call time via compilePattern itself.
const MAX_INPUT_SCHEMA_LINT_DEPTH = 12;

export function lintAssistantToolInputSchema(
  tool: Record<string, unknown>,
  errors: string[]
): void {
  walk(tool.inputSchema, `${String(tool.name ?? "?")}.inputSchema`, errors, 0);
}

function walk(schema: unknown, path: string, errors: string[], depth: number): void {
  if (depth > MAX_INPUT_SCHEMA_LINT_DEPTH) {
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  const node = schema as Record<string, unknown>;
  if (typeof node.pattern === "string") {
    try {
      compilePattern(node.pattern);
    } catch {
      errors.push(`assistant tool inputSchema pattern at ${path} is invalid: ${node.pattern}`);
    }
  }
  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    for (const [key, value] of Object.entries(node.properties as Record<string, unknown>)) {
      walk(value, `${path}.properties.${key}`, errors, depth + 1);
    }
  }
  if (node.items !== undefined) {
    walk(node.items, `${path}.items`, errors, depth + 1);
  }
}
