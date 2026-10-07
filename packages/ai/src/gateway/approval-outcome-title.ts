import type { ModuleAssistantToolManifest } from "@moss/module-sdk";

/**
 * Reuse only explicitly authored, plain card text for a quiet outcome. This is a
 * conservative presentation filter, not a security sanitizer or an input validator.
 * The pending card keeps its original disclosure when its title is unsuitable.
 */
export function approvalOutcomeTitle(
  tool: Pick<ModuleAssistantToolManifest, "name" | "summarize" | "actionLabel">,
  cardSummary: string
): string | undefined {
  if ((!tool.summarize && !tool.actionLabel) || typeof cardSummary !== "string") return undefined;
  // Some server card summaries emphasize a quoted target. Unwrap that one balanced form;
  // residual markup still fails the plain-text gate below, without rendering Markdown.
  const title = cardSummary
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title === tool.name) return undefined;

  // Paths, URLs, markup, code/config syntax and dotted internal tool names are not titles.
  if (/[/\\<>`*{}[\]|$;=_]/.test(title)) return undefined;
  if (/\b[a-z][\w-]*(?:\.[a-z][\w-]*)+\b/i.test(title)) return undefined;
  if (/\b(?:https?|file|mailto|ssh|ftp|smb):|(?:^|\s)--?[a-z]/i.test(title)) return undefined;
  // Opaque IDs can be embedded in otherwise human sentences, including older module summaries.
  if (/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(title)) return undefined;
  if (/\b[a-z]+-\d+\b|\b(?=[a-z\d]*\d)[a-z\d]{20,}\b/i.test(title)) return undefined;
  return title.slice(0, 200);
}
