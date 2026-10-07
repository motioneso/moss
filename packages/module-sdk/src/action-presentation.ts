import type { ChatContentClass } from "./route-chat.js";
import type { ToolContext, ToolInput, ToolServices } from "./index.js";

/** Human disclosure authored by a module, never inferred from input keys or model prose. */
export interface HumanActionDetails {
  /** Per-call module-authored title, frozen with the exact disclosure (never caller prose). */
  readonly title?: string;
  /** Actual disclosed text provenance; absent defaults to the owning hook declaration. */
  readonly content?: ChatContentClass;
  readonly target: string;
  readonly fields: readonly ApprovalField[];
  /** Server-only identity of resolved references; never sent to the browser. */
  readonly version?: string;
}

export interface ApprovalField {
  readonly label: string;
  readonly value: string;
}

/** A field must account for its entire value, including any nested references. */
export type ApprovalFieldPresenter = (value: unknown) => string | readonly ApprovalField[] | null;
export type ApprovalFieldMap = Readonly<
  Record<string, { readonly label: string; readonly present: ApprovalFieldPresenter }>
>;

/**
 * Exact, exhaustive disclosure: unknown keys and unsupported shapes invalidate the whole card.
 * An empty map accepts only an absent or empty object, never silently drops a submitted body.
 */
export function presentApprovalFields(
  input: unknown,
  declarations: ApprovalFieldMap,
  required: readonly string[] = []
): readonly ApprovalField[] | null {
  if (input === undefined) input = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const values = input as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(values, key))) return null;
  const fields: ApprovalField[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(declarations, key)) return null;
    const declaration = declarations[key]!;
    const shown = declaration.present(value);
    if (shown === null) return null;
    if (typeof shown === "string") fields.push({ label: declaration.label, value: shown });
    else {
      if (!Array.isArray(shown) || shown.length === 0) return null;
      fields.push(...shown);
    }
  }
  return fields.every(
    (field) =>
      field !== null &&
      typeof field === "object" &&
      typeof field.label === "string" &&
      field.label.trim() &&
      typeof field.value === "string"
  )
    ? fields
    : null;
}

export const approvalText: ApprovalFieldPresenter = (value) =>
  typeof value === "string" ? value : null;
export const approvalNumber: ApprovalFieldPresenter = (value) =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : null;
export const approvalBoolean: ApprovalFieldPresenter = (value) =>
  typeof value === "boolean" ? (value ? "Yes" : "No") : null;
export function approvalChoice(choices: Readonly<Record<string, string>>): ApprovalFieldPresenter {
  return (value) =>
    typeof value === "string" && Object.hasOwn(choices, value) ? choices[value]! : null;
}

/** Called under the actor's data scope. Undefined/null means disclosure is unavailable. */
export type ToolApprovalPresentation = (
  db: unknown,
  input: ToolInput,
  ctx: ToolContext,
  services?: ToolServices
) => Promise<HumanActionDetails | null>;

export interface ApprovalModuleReference {
  readonly id: string;
  readonly name: string;
  readonly notificationsSupported: boolean;
}

export interface RouteApprovalInput {
  /** Host-resolved active modules, never caller supplied. */
  readonly modules?: readonly ApprovalModuleReference[];
  readonly params: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly target: string | null;
}

export type RouteApprovalPresentation = (
  db: unknown,
  input: RouteApprovalInput,
  ctx: ToolContext
) => Promise<HumanActionDetails | null>;

/** Fixed authored correction only; never interpolate caller values, row text or dependency errors. */
export class ApprovalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalInputError";
  }
}
