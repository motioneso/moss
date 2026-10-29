/** Server-authored context for a declared owning action; never an execution grant. */
export interface ModuleNoticeActionReference {
  readonly toolName: string;
  readonly label: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
}

/** The source identity is always loaded through its owning public service. */
export interface ModuleNoticeSource {
  readonly moduleId: string;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly noticeKind: string;
}

export interface ChatModuleNoticeOriginV1 extends ModuleNoticeSource {
  readonly version: 1;
  readonly kind: "module_notice";
  readonly noticeId: string;
  readonly actions: readonly ModuleNoticeActionReference[];
}

export const moduleNoticeActionReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["toolName", "label", "sourceId", "sourceVersion"],
  properties: {
    toolName: { type: "string", minLength: 1, maxLength: 120 },
    label: { type: "string", minLength: 1, maxLength: 120 },
    sourceId: { type: "string", format: "uuid" },
    sourceVersion: { type: "string", minLength: 1, maxLength: 160 }
  }
} as const;

export const chatModuleNoticeOriginSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "kind",
    "noticeId",
    "moduleId",
    "sourceId",
    "sourceVersion",
    "noticeKind",
    "actions"
  ],
  properties: {
    version: { type: "number", enum: [1] },
    kind: { type: "string", enum: ["module_notice"] },
    noticeId: { type: "string", format: "uuid" },
    moduleId: { type: "string", minLength: 1, maxLength: 80 },
    sourceId: { type: "string", format: "uuid" },
    sourceVersion: { type: "string", minLength: 1, maxLength: 160 },
    noticeKind: { type: "string", minLength: 1, maxLength: 80 },
    actions: { type: "array", maxItems: 4, items: moduleNoticeActionReferenceSchema }
  }
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= max &&
    !value.includes("\0")
  );
}

/** Unknown provenance stays absent; no stored value becomes execution authority. */
export function readModuleNoticeOrigin(value: unknown): ChatModuleNoticeOriginV1 | undefined {
  const row = record(value);
  if (
    row.version !== 1 ||
    row.kind !== "module_notice" ||
    typeof row.noticeId !== "string" ||
    !isUuid(row.noticeId) ||
    typeof row.moduleId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,79}$/.test(row.moduleId) ||
    typeof row.sourceId !== "string" ||
    !isUuid(row.sourceId) ||
    !text(row.sourceVersion, 160) ||
    typeof row.noticeKind !== "string" ||
    !/^[a-z][a-z0-9_-]{0,79}$/.test(row.noticeKind) ||
    !Array.isArray(row.actions) ||
    row.actions.length > 4
  )
    return undefined;
  const actions: ModuleNoticeActionReference[] = [];
  const names = new Set<string>();
  for (const input of row.actions) {
    const action = record(input);
    if (
      !text(action.toolName, 120) ||
      !text(action.label, 120) ||
      names.has(action.toolName) ||
      action.sourceId !== row.sourceId ||
      action.sourceVersion !== row.sourceVersion
    )
      return undefined;
    names.add(action.toolName);
    actions.push({
      toolName: action.toolName,
      label: action.label,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion
    });
  }
  return {
    version: 1,
    kind: "module_notice",
    noticeId: row.noticeId,
    moduleId: row.moduleId,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    noticeKind: row.noticeKind,
    actions
  };
}
