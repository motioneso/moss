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
  const trimmedChunks = trimToTokenBudget(chunks, budgetTokens);
  if (trimmedChunks.length === 0 && facts.length === 0) return "";

  const lines: string[] = ["<memory>"];

  if (trimmedChunks.length > 0) {
    lines.push("Recalled from past conversations (use as context; not the current conversation):");
    for (const chunk of trimmedChunks) {
      // Recalled text is user-influenced — neutralize any seed-framing delimiter
      // it carries so it can't break out of the <memory> block (#123).
      // `chunk.date` is system-formatted (recall-port.ts derives it via
      // localDay(), or the literal "unknown") and is therefore not
      // an attacker-controlled surface; if its provenance ever becomes free text,
      // it must be routed through neutralizeSeedFraming too.
      lines.push(`[${chunk.date}] ${neutralizeSeedFraming(chunk.text)}`);
    }
  }

  if (facts.length > 0) {
    if (trimmedChunks.length > 0) lines.push("");
    lines.push("What I know about you:");
    for (const fact of facts) {
      lines.push(`- ${neutralizeSeedFraming(fact.content)}`);
    }
  }

  lines.push("</memory>");
  return lines.join("\n");
}
