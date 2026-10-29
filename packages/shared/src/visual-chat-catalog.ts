import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
import {
  validateVisualReply,
  VISUAL_LIMITS,
  type VisualReplyV1,
  type VisualReplyValidation,
  type VisualSnapshotV1,
  type VisualValue
} from "./visual-chat.js";

export const VISUAL_CATALOG_VERSION = "moss.user-data.1";
export const BUILT_IN_VISUAL_CATALOG_VERSION = "moss.builtins.1";
const templates = new Map<string, ModuleVisualTemplate>();
let catalogInstalled = false;

/** Boot-time composition of reviewed built-ins, shared by save/history and browser boundaries. */
export function installBuiltInVisualTemplates(
  registrations: readonly ModuleVisualTemplate[]
): void {
  if (catalogInstalled) {
    if (
      registrations.length === templates.size &&
      registrations.every((t) => templates.get(t.kind) === t)
    )
      return;
    throw new Error("Built-in visual catalog is already installed");
  }
  const seen = new Set<string>();
  const snapshotKinds = new Set<string>();
  for (const template of registrations) {
    if (
      !/^[a-z][a-z0-9.:-]{1,63}$/.test(template.kind) ||
      seen.has(template.kind) ||
      template.kind === "composition" ||
      !template.snapshotKind ||
      snapshotKinds.has(template.snapshotKind) ||
      (templates.has(template.kind) && templates.get(template.kind) !== template)
    )
      throw new Error(`Duplicate or invalid visual template: ${template.kind}`);
    seen.add(template.kind);
    snapshotKinds.add(template.snapshotKind);
  }
  for (const template of registrations) templates.set(template.kind, Object.freeze(template));
  catalogInstalled = true;
}

export function builtInVisualTemplate(kind: string): ModuleVisualTemplate | undefined {
  return templates.get(kind);
}

export function snapshotVisualTemplate(
  snapshot: VisualSnapshotV1
): ModuleVisualTemplate | undefined {
  return [...templates.values()].find(
    (template) => template.snapshotKind === snapshot.kind && template.validate(snapshot)
  );
}
export interface VisualFactBinding {
  ref: string;
  field: string;
}
export interface VisualSection {
  title: string;
  facts: VisualFactBinding[];
}

/** Complete, non-recursive grammar; upstream parser recovery never admits extra syntax. */
export function parseVisualProgram(program: string): VisualSection[] | null {
  if (program.length > VISUAL_LIMITS.programLength) return null;
  const token =
    /\s+|"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[A-Za-z][A-Za-z0-9_]*|[=[\](),;]/y; // eslint-disable-line no-control-regex
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < program.length) {
    token.lastIndex = cursor;
    const match = token.exec(program);
    if (!match) return null;
    cursor = token.lastIndex;
    if (match[0].trim()) tokens.push(match[0]);
  }
  let position = 0;
  const take = (expected: string) => {
    if (tokens[position] !== expected) throw new Error("Unexpected token");
    position++;
  };
  const string = (): string => {
    const value = tokens[position++];
    if (!value?.startsWith('"')) throw new Error("Expected string");
    const decoded: string = JSON.parse(value);
    if (!decoded || decoded.length > VISUAL_LIMITS.stringLength) throw new Error("String limit");
    return decoded;
  };
  const list = <T>(read: () => T, max: number): T[] => {
    take("[");
    const values: T[] = [];
    do {
      if (values.length) take(",");
      if (values.length >= max) throw new Error("List limit");
      values.push(read());
    } while (tokens[position] === ",");
    take("]");
    return values;
  };
  let facts = 0;
  try {
    take("root");
    take("=");
    take("Reply");
    take("(");
    const sections = list(() => {
      take("Section");
      take("(");
      const title = string();
      take(",");
      const bindings = list(() => {
        if (++facts > 3) throw new Error("Fact limit");
        take("Fact");
        take("(");
        const ref = string();
        take(",");
        const field = string();
        take(")");
        return { ref, field };
      }, 3);
      take(")");
      return { title, facts: bindings };
    }, 3);
    take(")");
    if (tokens[position] === ";") position++;
    return position === tokens.length ? sections : null;
  } catch {
    return null;
  }
}

export function isVisualScalar(
  value: VisualValue | undefined
): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function visualFactValue(snapshot: VisualSnapshotV1, field: string): string | null {
  if (!Object.hasOwn(snapshot.fields, field)) return null;
  const value = snapshot.fields[field];
  return isVisualScalar(value) ? (value === null ? "Unknown" : String(value)) : null;
}

/** Shape plus catalog, binding and capability validation, shared by save and render boundaries. */
export function validateVisualCatalogReply(value: unknown): VisualReplyValidation {
  const shape = validateVisualReply(value);
  if (!shape.ok) return shape;
  const reply = shape.reply;
  const reject = (code: "unsupported_catalog" | "invalid_program"): VisualReplyValidation => ({
    ok: false,
    code,
    fallbackText: reply.fallbackText
  });
  if (reply.catalogVersion === BUILT_IN_VISUAL_CATALOG_VERSION) {
    if (reply.interactions.length || reply.blocks.length !== 1 || reply.snapshots.length !== 1)
      return reject("unsupported_catalog");
    const block = reply.blocks[0]!;
    const snapshot = reply.snapshots[0]!;
    const template = builtInVisualTemplate(block.kind);
    if (
      !template ||
      block.program !== undefined ||
      block.snapshotRefs.length !== 1 ||
      block.snapshotRefs[0] !== snapshot.ref ||
      snapshot.kind !== template.snapshotKind ||
      !template.validate(snapshot)
    )
      return reject("invalid_program");
    return shape;
  }
  if (
    reply.catalogVersion !== VISUAL_CATALOG_VERSION ||
    reply.interactions.length ||
    reply.blocks.length !== 1
  )
    return reject("unsupported_catalog");
  const block = reply.blocks[0]!;
  const sections =
    block.kind === "composition" && block.program ? parseVisualProgram(block.program) : null;
  if (!sections) return reject("invalid_program");
  const snapshots = new Map(reply.snapshots.map((snapshot) => [snapshot.ref, snapshot]));
  const used = new Set<string>();
  for (const { facts } of sections) {
    for (const fact of facts) {
      const snapshot = snapshots.get(fact.ref);
      if (
        !block.snapshotRefs.includes(fact.ref) ||
        !snapshot ||
        snapshot.kind !== "user.data" ||
        snapshot.origin !== "user" ||
        snapshot.source.id !== "user-supplied" ||
        snapshot.source.label !== "Your data" ||
        visualFactValue(snapshot, fact.field) === null
      )
        return reject("invalid_program");
      used.add(fact.ref);
    }
  }
  if (used.size !== block.snapshotRefs.length || used.size !== snapshots.size)
    return reject("invalid_program");
  return shape;
}

/** Compatibility text is bounded even when a future or damaged envelope cannot render. */
export function readStoredVisual(value: unknown): {
  visualReply?: VisualReplyV1;
  visualFallbackText?: string;
} {
  if (value === undefined) return {};
  const result = validateVisualCatalogReply(value);
  return result.ok
    ? { visualReply: result.reply }
    : result.fallbackText
      ? { visualFallbackText: result.fallbackText }
      : {};
}

export function visualReplyText(body: string, fallback?: string): string {
  return fallback ? `${body}\n\n${fallback}` : body;
}

export function storedVisualText(body: string, envelope: unknown): string {
  const visual = readStoredVisual(envelope);
  return visualReplyText(body, visual.visualReply?.fallbackText ?? visual.visualFallbackText);
}
