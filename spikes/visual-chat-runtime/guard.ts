import { createParser, type ElementNode } from "@openuidev/lang-core";
import { catalogSchema, factProps, replyProps, sectionProps } from "./schemas.js";

const parser = createParser(catalogSchema, "Reply");
const MAX_BYTES = 64 * 1024;
const MAX_NESTING = 8;
const MAX_NODES = 80;

// The experiment accepts one root assignment, registered calls, arrays and JSON strings.
// No named references, expressions, objects, actions, state, queries or protocol markers.
// Lexical checks run BEFORE the upstream permissive parser, with bounded nesting/input.
function allowedSyntax(program: string): boolean {
  // JSON string literals cannot contain unescaped C0 control characters.
  const token =
    /\s+|"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[A-Za-z][A-Za-z0-9_]*|[=[\](),;]/y; // eslint-disable-line no-control-regex
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < program.length) {
    token.lastIndex = cursor;
    const match = token.exec(program);
    if (!match) return false;
    cursor = token.lastIndex;
    if (match[0].trim()) tokens.push(match[0]);
  }
  if (tokens[0] !== "root" || tokens[1] !== "=") return false;
  const stack: string[] = [];
  let nodes = 0;
  for (let i = 2; i < tokens.length; i++) {
    const value = tokens[i]!;
    if (value.startsWith('"')) continue;
    if (["Reply", "Section", "Fact"].includes(value)) {
      if (tokens[i + 1] !== "(" || ++nodes > MAX_NODES) return false;
    } else if (value === "(" || value === "[") {
      stack.push(value);
      if (stack.length > MAX_NESTING) return false;
    } else if (value === ")" || value === "]") {
      if (stack.pop() !== (value === ")" ? "(" : "[")) return false;
    } else if (value === ";") {
      if (i !== tokens.length - 1 || stack.length) return false;
    } else if (value !== ",") return false;
  }
  return stack.length === 0;
}

function element(value: unknown, name: string): value is ElementNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "element" &&
    "typeName" in value &&
    value.typeName === name &&
    "partial" in value &&
    value.partial === false
  );
}

function validTree(root: ElementNode): boolean {
  if (!element(root, "Reply")) return false;
  const reply = replyProps.safeParse(root.props);
  if (!reply.success) return false;
  let facts = 0;
  for (const section of reply.data.children) {
    if (!element(section, "Section")) return false;
    const parsed = sectionProps.safeParse(section.props);
    if (!parsed.success) return false;
    for (const fact of parsed.data.children) {
      if (!element(fact, "Fact") || !factProps.safeParse(fact.props).success || ++facts > 3)
        return false;
    }
  }
  return true;
}

export function validateProgram(program: unknown): boolean {
  if (
    typeof program !== "string" ||
    new TextEncoder().encode(program).byteLength > MAX_BYTES ||
    !allowedSyntax(program)
  )
    return false;
  try {
    const parsed = parser.parse(program);
    return (
      parsed.root !== null &&
      !parsed.rootExpression &&
      !parsed.meta.incomplete &&
      parsed.meta.errors.length === 0 &&
      parsed.meta.unresolved.length === 0 &&
      parsed.meta.orphaned.length === 0 &&
      parsed.meta.statementCount === 1 &&
      Object.keys(parsed.stateDeclarations).length === 0 &&
      parsed.queryStatements.length === 0 &&
      parsed.mutationStatements.length === 0 &&
      validTree(parsed.root)
    );
  } catch {
    return false;
  }
}
