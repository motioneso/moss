import { neutralizeSeedFraming } from "./prompt-safety.js";

export interface EpisodicChunk {
  readonly text: string;
  readonly date: string;
  readonly threadId: string;
  readonly hybridScore: number;
}

export interface FactSummary {
  readonly category: string;
  readonly content: string;
}

/** λ for recency decay: exp(-λ * days). At λ=0.05, half-life ≈ 14 days. */
const LAMBDA = 0.05;

/** Hybrid score: 60% cosine similarity + 25% recency decay. */
export function hybridScore(similarity: number, recencyDecay: number): number {
  return 0.6 * similarity + 0.25 * recencyDecay;
}

/** Recency decay: exp(-λ * daysAgo). Returns 1.0 at 0 days, ~0.5 at 14 days. */
export function applyRecencyDecay(daysAgo: number): number {
  return Math.exp(-LAMBDA * daysAgo);
}

/** Approximate token count: 1 token ≈ 4 chars (±20% for typical prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function trimToTokenBudget(
  chunks: readonly EpisodicChunk[],
  budgetTokens: number
): readonly EpisodicChunk[] {
  const sorted = [...chunks].sort((a, b) => a.hybridScore - b.hybridScore);
  const kept: EpisodicChunk[] = [];
  let used = 0;
  for (const chunk of sorted.reverse()) {
    const est = estimateTokens(chunk.text);
    if (used + est > budgetTokens) break;
    kept.push(chunk);
    used += est;
  }
  return kept;
}

export function renderMemorySeedBlock(
  chunks: readonly EpisodicChunk[],
  facts: readonly FactSummary[],
  budgetTokens = 1500
): string {
  // The whole block, framing included, stays within the budget. Saved facts take priority over
  // recalled passages, and passages are taken best-scored first.
  const factLines = facts.map((fact) => `- ${neutralizeSeedFraming(fact.content)}`);
  const ranked = [...chunks].sort((a, b) => b.hybridScore - a.hybridScore);
  const fits = (chunkLines: readonly string[], keptFacts: readonly string[]) =>
    estimateTokens(renderSeedLines(chunkLines, keptFacts)) <= budgetTokens;

  const keptFacts: string[] = [];
  for (const line of factLines) {
    if (!fits([], [...keptFacts, line])) break;
    keptFacts.push(line);
  }

  const keptChunks: string[] = [];
  for (const chunk of ranked) {
    // Recalled text is user-influenced — neutralize any seed-framing delimiter
    // it carries so it can't break out of the <memory> block (#123).
    // `chunk.date` is system-formatted (recall-port.ts derives it via
    // toISOString().slice(0,10), or the literal "unknown") and is therefore not
    // an attacker-controlled surface; if its provenance ever becomes free text,
    // it must be routed through neutralizeSeedFraming too.
    const line = `[${chunk.date}] ${neutralizeSeedFraming(chunk.text)}`;
    if (!fits([...keptChunks, line], keptFacts)) break;
    keptChunks.push(line);
  }

  return renderSeedLines(keptChunks, keptFacts);
}

function renderSeedLines(chunkLines: readonly string[], factLines: readonly string[]): string {
  if (chunkLines.length === 0 && factLines.length === 0) return "";

  const lines: string[] = ["<memory>"];
  if (chunkLines.length > 0) {
    lines.push("Recalled from past conversations (use as context; not the current conversation):");
    lines.push(...chunkLines);
  }
  if (factLines.length > 0) {
    if (chunkLines.length > 0) lines.push("");
    lines.push("What I know about you:");
    lines.push(...factLines);
  }
  lines.push("</memory>");
  return lines.join("\n");
}
