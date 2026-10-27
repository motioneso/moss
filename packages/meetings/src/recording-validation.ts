import type { RecordingInterpretation, RecordingOutputContext } from "@moss/shared";

/** Values describe evidence; they never select a tool, destination path or permission. */
export function validateRecordingInterpretation(
  value: unknown,
  context: RecordingOutputContext
): RecordingInterpretation {
  const fail = (): never => {
    throw new Error("Invalid recording interpretation");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const keys = ["title", "typeId", "side", "confidence", "reason", "ideaGroups"];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    return fail();
  const text = (value: unknown, max: number): string => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
      return fail();
    return value.trim();
  };
  const title = text(row.title, 240);
  if (Buffer.byteLength(title) > 240) return fail();
  const typeId = text(row.typeId, 64);
  if (
    !context.configuration.types.some((type) => type.id === typeId && !type.retired) ||
    (row.side !== "personal" && row.side !== "work") ||
    typeof row.confidence !== "number" ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1 ||
    !Array.isArray(row.ideaGroups) ||
    row.ideaGroups.length > 12
  )
    return fail();
  const groups: RecordingInterpretation["ideaGroups"] = row.ideaGroups.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    const group = value as Record<string, unknown>;
    if (
      Object.keys(group).length !== 2 ||
      !Array.isArray(group.ideas) ||
      !group.ideas.length ||
      group.ideas.length > 20
    )
      return fail();
    return { title: text(group.title, 200), ideas: group.ideas.map((idea) => text(idea, 1000)) };
  });
  if (
    groups.reduce(
      (count, group) =>
        count + group.ideas.reduce((sum, idea) => sum + idea.length, group.title.length),
      0
    ) > 16000
  )
    return fail();
  return {
    title,
    typeId,
    side: row.side,
    confidence: row.confidence,
    reason: text(row.reason, 1000),
    ideaGroups: groups
  };
}
