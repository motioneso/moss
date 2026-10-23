import { isVisualScalar, VISUAL_CATALOG_VERSION, type VisualObject } from "@moss/shared";

/** Exact supplied fields, never model extraction. Complex/oversized inputs remain ordinary text. */
export function promptVisualFields(text: string): VisualObject {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  try {
    const value: unknown = JSON.parse(fenced?.[1] ?? text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length && entries.every(([, field]) => isVisualScalar(field)))
        return Object.fromEntries(entries);
    }
  } catch {
    // The original message is itself user-supplied data, within the registry's normal bounds.
  }
  return { text };
}

export function presentationContext(ref: string, fields: VisualObject): string {
  const field = Object.keys(fields).find((key) => isVisualScalar(fields[key]));
  if (!field) return "";
  const program = `root = Reply([Section("Details", [Fact(${JSON.stringify(ref)}, ${JSON.stringify(field)})])]);`;
  return [
    "Visual presentation for this turn: choose a visual only when it clarifies the answer. Honor text-only requests; simple answers stay prose. Arrange the registered components with chat.present at most once. Keep a useful ordinary text answer. Bind facts only to the supplied snapshot and fields; never invent values or refs. If refused, use prose without retrying or showing the program.",
    "Signatures: Reply([Section(title, [Fact(snapshotRef, field)])]). One composition; at most three sections and three facts total. No other syntax or interactions.",
    `Host snapshot (Your data, not independently verified): ${JSON.stringify({ ref, fields: Object.keys(fields) })}`,
    `Worked tool input: ${JSON.stringify({ proposal: { catalogVersion: VISUAL_CATALOG_VERSION, blocks: [{ kind: "composition", snapshotRefs: [ref], program }], interactions: [] } })}`
  ].join("\n");
}
