/**
 * Renderer-independent contracts for visual chat replies (stage 1b.1).
 *
 * Validation here is shape-only. A program that passes is not known to be safe to render;
 * catalog names, argument schemas, node count and component depth belong to the later
 * renderer-side semantic validator.
 */

export const VISUAL_REPLY_VERSION = 1;

export const VISUAL_LIMITS = {
  envelopeBytes: 64 * 1024,
  blocks: 3,
  interactions: 6,
  refsPerBlock: 4,
  snapshotsPerReply: 8,
  snapshotBytes: 16 * 1024,
  valueDepth: 4,
  arrayLength: 24,
  objectKeys: 32,
  stringLength: 500,
  programLength: 16 * 1024,
  fallbackTextLength: 4000,
  paramCount: 4
} as const;

export type VisualValue = string | number | boolean | null | VisualValue[] | VisualObject;
export interface VisualObject {
  [key: string]: VisualValue;
}

export type VisualOrigin = "source" | "user" | "example";
export type VisualInteractionKind = "follow_up" | "navigate" | "action_request";
export type VisualParam = string | number | boolean;

export interface VisualSnapshotV1 {
  ref: string;
  kind: string;
  origin: VisualOrigin;
  source: { id: string; label: string };
  retrievedAt: string;
  coverage: string;
  revision?: string;
  fields: VisualObject;
}

export interface VisualBlockV1 {
  blockId: string;
  kind: string;
  snapshotRefs: string[];
  program?: string;
}

export interface VisualInteractionV1 {
  interactionId: string;
  blockId: string;
  kind: VisualInteractionKind;
  label: string;
  descriptorId: string;
  snapshotRef?: string;
  params: Record<string, VisualParam>;
}

export interface VisualReplyV1 {
  version: typeof VISUAL_REPLY_VERSION;
  catalogVersion: string;
  blocks: VisualBlockV1[];
  snapshots: VisualSnapshotV1[];
  interactions: VisualInteractionV1[];
  fallbackText: string;
}

export interface VisualProposalBlockV1 {
  kind: string;
  snapshotRefs: string[];
  program?: string;
}

export interface VisualProposalInteractionV1 {
  /** Index into the proposal's blocks. */
  blockIndex: number;
  kind: VisualInteractionKind;
  label: string;
  descriptorId: string;
  snapshotRef?: string;
  params: Record<string, VisualParam>;
}

/** What the model may propose. It carries no ids, snapshots, source labels or fallback text. */
export interface VisualPresentationProposalV1 {
  catalogVersion: string;
  blocks: VisualProposalBlockV1[];
  interactions: VisualProposalInteractionV1[];
}

export type VisualFailureCode =
  | "not_object"
  | "unsupported_version"
  | "too_large"
  | "not_serializable"
  | "malformed"
  | "limit_exceeded"
  | "dangling_reference";

/** Failures keep any readable text so callers can still show the ordinary answer. */
export type VisualReplyValidation =
  | { ok: true; reply: VisualReplyV1 }
  | { ok: false; code: VisualFailureCode; fallbackText: string | null };

export type VisualProposalValidation =
  | { ok: true; proposal: VisualPresentationProposalV1 }
  | { ok: false; code: VisualFailureCode };

class Reject extends Error {
  constructor(readonly code: VisualFailureCode) {
    super(code);
  }
}

const SNAPSHOT_KEYS = [
  "ref",
  "kind",
  "origin",
  "source",
  "retrievedAt",
  "coverage",
  "revision",
  "fields"
];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ORIGINS: readonly string[] = ["source", "user", "example"];
const INTERACTION_KINDS: readonly string[] = ["follow_up", "navigate", "action_request"];

function bad(code: VisualFailureCode = "malformed"): never {
  throw new Reject(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[]
) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad();
  for (const key of required) if (!(key in value)) bad();
}

function text(value: unknown, max: number = VISUAL_LIMITS.stringLength): string {
  if (typeof value !== "string" || value.length === 0) bad();
  if (value.length > max) bad("limit_exceeded");
  return value;
}

function name(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) bad();
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) bad();
  if (value.length > max) bad("limit_exceeded");
  return value;
}

export function copyVisualValue(value: unknown, depth = 1): VisualValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > VISUAL_LIMITS.stringLength) bad("limit_exceeded");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad("not_serializable");
    return value;
  }
  if (depth > VISUAL_LIMITS.valueDepth) bad("limit_exceeded");
  if (Array.isArray(value)) {
    return array(value, VISUAL_LIMITS.arrayLength).map((item) => copyVisualValue(item, depth + 1));
  }
  if (!isPlainObject(value)) bad("not_serializable");
  const keys = Object.keys(value);
  if (keys.length > VISUAL_LIMITS.objectKeys) bad("limit_exceeded");
  const out: VisualObject = {};
  for (const key of keys) {
    if (key === "__proto__") bad();
    out[key] = copyVisualValue(value[key], depth + 1);
  }
  return out;
}

function byteLength(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    bad("not_serializable");
  }
  if (json === undefined) bad("not_serializable");
  return new TextEncoder().encode(json).length;
}

/** Validates and copies explicit snapshot fields. The caller supplies `ref`. */
export function copyVisualSnapshot(value: unknown): VisualSnapshotV1 {
  if (!isPlainObject(value)) bad();
  exactKeys(value, SNAPSHOT_KEYS, [
    "ref",
    "kind",
    "origin",
    "source",
    "retrievedAt",
    "coverage",
    "fields"
  ]);
  if (typeof value.origin !== "string" || !ORIGINS.includes(value.origin)) bad();
  if (!isPlainObject(value.source)) bad();
  exactKeys(value.source, ["id", "label"], ["id", "label"]);
  if (typeof value.retrievedAt !== "string" || Number.isNaN(Date.parse(value.retrievedAt))) bad();
  if (!isPlainObject(value.fields)) bad();
  const snapshot: VisualSnapshotV1 = {
    ref: name(value.ref),
    kind: name(value.kind),
    origin: value.origin as VisualOrigin,
    source: { id: text(value.source.id), label: text(value.source.label) },
    retrievedAt: value.retrievedAt,
    coverage: text(value.coverage),
    fields: copyVisualValue(value.fields) as VisualObject
  };
  if (value.revision !== undefined) snapshot.revision = text(value.revision);
  if (byteLength(snapshot) > VISUAL_LIMITS.snapshotBytes) bad("limit_exceeded");
  return snapshot;
}

export type VisualSnapshotCopy =
  | { ok: true; snapshot: VisualSnapshotV1 }
  | { ok: false; code: VisualFailureCode };

export function tryCopyVisualSnapshot(value: unknown): VisualSnapshotCopy {
  try {
    return { ok: true, snapshot: copyVisualSnapshot(value) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code };
    throw error;
  }
}

function copyParams(value: unknown): Record<string, VisualParam> {
  if (!isPlainObject(value)) bad();
  const keys = Object.keys(value);
  if (keys.length > VISUAL_LIMITS.paramCount) bad("limit_exceeded");
  const out: Record<string, VisualParam> = {};
  for (const key of keys) {
    const item = value[key];
    if (key === "__proto__") bad();
    if (typeof item === "number" && !Number.isFinite(item)) bad("not_serializable");
    if (typeof item === "string") text(item);
    else if (typeof item !== "number" && typeof item !== "boolean") bad();
    out[name(key)] = item;
  }
  return out;
}

function copyBlockFields(value: Record<string, unknown>) {
  const kind = name(value.kind);
  const snapshotRefs = array(value.snapshotRefs, VISUAL_LIMITS.refsPerBlock).map(name);
  if (snapshotRefs.length === 0 && kind !== "composition") bad();
  if (value.program !== undefined && kind !== "composition") bad();
  if (kind === "composition" && value.program === undefined) bad();
  const program =
    value.program === undefined ? undefined : text(value.program, VISUAL_LIMITS.programLength);
  return { kind, snapshotRefs, ...(program === undefined ? {} : { program }) };
}

function copyInteractionFields(value: Record<string, unknown>) {
  if (typeof value.kind !== "string" || !INTERACTION_KINDS.includes(value.kind)) bad();
  const out = {
    kind: value.kind as VisualInteractionKind,
    label: text(value.label),
    descriptorId: name(value.descriptorId),
    params: copyParams(value.params ?? {})
  };
  return value.snapshotRef === undefined ? out : { ...out, snapshotRef: name(value.snapshotRef) };
}

function readableFallback(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const fallback = value.fallbackText;
  return typeof fallback === "string" &&
    fallback.length > 0 &&
    fallback.length <= VISUAL_LIMITS.fallbackTextLength
    ? fallback
    : null;
}

export function validateVisualReply(value: unknown): VisualReplyValidation {
  const fallbackText = readableFallback(value);
  try {
    return { ok: true, reply: parseReply(value) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code, fallbackText };
    throw error;
  }
}

function parseReply(value: unknown): VisualReplyV1 {
  if (!isPlainObject(value)) bad("not_object");
  if (value.version !== VISUAL_REPLY_VERSION) bad("unsupported_version");
  if (byteLength(value) > VISUAL_LIMITS.envelopeBytes) bad("too_large");
  exactKeys(
    value,
    ["version", "catalogVersion", "blocks", "snapshots", "interactions", "fallbackText"],
    ["version", "catalogVersion", "blocks", "snapshots", "interactions", "fallbackText"]
  );
  const snapshots = array(value.snapshots, VISUAL_LIMITS.snapshotsPerReply).map(copyVisualSnapshot);
  const refs = new Set(snapshots.map((snapshot) => snapshot.ref));
  if (refs.size !== snapshots.length) bad();
  const blocks = array(value.blocks, VISUAL_LIMITS.blocks).map((raw): VisualBlockV1 => {
    if (!isPlainObject(raw)) bad();
    exactKeys(
      raw,
      ["blockId", "kind", "snapshotRefs", "program"],
      ["blockId", "kind", "snapshotRefs"]
    );
    return { blockId: name(raw.blockId), ...copyBlockFields(raw) };
  });
  if (blocks.length === 0) bad();
  const blockIds = new Set(blocks.map((block) => block.blockId));
  if (blockIds.size !== blocks.length) bad();
  for (const block of blocks) {
    if (block.snapshotRefs.some((ref) => !refs.has(ref))) bad("dangling_reference");
  }
  const interactions = array(value.interactions, VISUAL_LIMITS.interactions).map(
    (raw): VisualInteractionV1 => {
      if (!isPlainObject(raw)) bad();
      exactKeys(
        raw,
        ["interactionId", "blockId", "kind", "label", "descriptorId", "snapshotRef", "params"],
        ["interactionId", "blockId", "kind", "label", "descriptorId", "params"]
      );
      const blockId = name(raw.blockId);
      if (!blockIds.has(blockId)) bad("dangling_reference");
      const interaction: VisualInteractionV1 = {
        interactionId: name(raw.interactionId),
        blockId,
        ...copyInteractionFields(raw)
      };
      if (interaction.snapshotRef !== undefined && !refs.has(interaction.snapshotRef)) {
        bad("dangling_reference");
      }
      return interaction;
    }
  );
  const interactionIds = new Set(interactions.map((interaction) => interaction.interactionId));
  if (interactionIds.size !== interactions.length) bad();
  return {
    version: VISUAL_REPLY_VERSION,
    catalogVersion: name(value.catalogVersion),
    blocks,
    snapshots,
    interactions,
    fallbackText: text(value.fallbackText, VISUAL_LIMITS.fallbackTextLength)
  };
}

/** Shape-checks a model proposal. Reference ownership is checked by the turn registry. */
export function validateVisualProposal(value: unknown): VisualProposalValidation {
  try {
    if (!isPlainObject(value)) bad("not_object");
    if (byteLength(value) > VISUAL_LIMITS.envelopeBytes) bad("too_large");
    exactKeys(value, ["catalogVersion", "blocks", "interactions"], ["catalogVersion", "blocks"]);
    const blocks = array(value.blocks, VISUAL_LIMITS.blocks).map((raw): VisualProposalBlockV1 => {
      if (!isPlainObject(raw)) bad();
      exactKeys(raw, ["kind", "snapshotRefs", "program"], ["kind", "snapshotRefs"]);
      return copyBlockFields(raw);
    });
    if (blocks.length === 0) bad();
    const interactions = array(value.interactions ?? [], VISUAL_LIMITS.interactions).map(
      (raw): VisualProposalInteractionV1 => {
        if (!isPlainObject(raw)) bad();
        exactKeys(
          raw,
          ["blockIndex", "kind", "label", "descriptorId", "snapshotRef", "params"],
          ["blockIndex", "kind", "label", "descriptorId"]
        );
        const { blockIndex } = raw;
        if (typeof blockIndex !== "number" || !Number.isInteger(blockIndex)) bad();
        if (blockIndex < 0 || blockIndex >= blocks.length) bad("dangling_reference");
        return { blockIndex, ...copyInteractionFields(raw) };
      }
    );
    return {
      ok: true,
      proposal: { catalogVersion: name(value.catalogVersion), blocks, interactions }
    };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, code: error.code };
    throw error;
  }
}
