import type {
  PutRecordingTypeConfigurationInput,
  RecordingType,
  RecordingTypeConfiguration
} from "@moss/shared";
import { RecordingIdentityError } from "./recording-identity-error.js";

function invalid(code = "recording_type_configuration_invalid"): never {
  throw new RecordingIdentityError(code);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    return invalid();
  return result;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
    return invalid();
  return value.trim();
}
/** Strict before Ajv stripping, and for direct repository and approval callers. */
export function validateRecordingTypeConfiguration(
  value: unknown
): PutRecordingTypeConfigurationInput {
  const input = object(value, ["expectedRevision", "types"]);
  if (
    typeof input.expectedRevision !== "number" ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision > 2147483646
  )
    return invalid();
  if (!Array.isArray(input.types) || !input.types.length) return invalid();
  if (input.types.length > 32) return invalid("recording_type_limit");
  if (Buffer.byteLength(JSON.stringify(value)) > 65536)
    return invalid("recording_type_configuration_too_large");
  const ids = new Set<string>();
  const names = new Set<string>();
  const types: RecordingType[] = Array.from(input.types, (value) => {
    const type = object(value, ["id", "name", "description", "templateId", "retired"]);
    if (typeof type.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(type.id)) return invalid();
    const name = text(type.name, 80);
    const description = text(type.description, 500);
    if (ids.has(type.id) || names.has(name.toLowerCase())) return invalid();
    ids.add(type.id);
    names.add(name.toLowerCase());
    if (
      type.templateId !== "general" &&
      type.templateId !== "one-to-one" &&
      type.templateId !== "project-review" &&
      type.templateId !== "interview"
    )
      return invalid();
    if (typeof type.retired !== "boolean") return invalid();
    return { id: type.id, name, description, templateId: type.templateId, retired: type.retired };
  });
  if (!types.some((type) => !type.retired)) return invalid();
  const configuration = { revision: input.expectedRevision + 1, types };
  if (JSON.stringify(configuration, null, 2).length > 12000)
    return invalid("recording_type_configuration_too_large");
  return { expectedRevision: input.expectedRevision, types };
}
export function prepareRecordingTypeConfiguration(
  current: RecordingTypeConfiguration,
  raw: PutRecordingTypeConfigurationInput
): RecordingTypeConfiguration {
  const input = validateRecordingTypeConfiguration(raw);
  if (input.expectedRevision !== current.revision)
    throw new RecordingIdentityError("recording_type_configuration_conflict", 409);
  const existing = new Set(current.types.map((type) => type.id));
  if (
    current.types.some((type) => !input.types.some((next) => next.id === type.id)) ||
    input.types.some((type) => !existing.has(type.id) && type.retired)
  )
    return invalid();
  return { revision: current.revision + 1, types: input.types };
}
