import type { TextChunk } from "@moss/memory";

/**
 * The local embedder reads at most `EMBED_MAX_TOKENS` (512) tokens per call and silently drops the
 * rest (memory's local-embedding-provider). A segment holds up to 8 KB plus a title and address, so
 * it is split here, and every chunk gets the segment's own source path (plan Q6).
 *
 * Memory's own `parseDocument` can't do this job: it bounds a chunk by characters (2000, about 500
 * tokens of plain English, so no margin), and it treats a leading `---` as frontmatter and `## ` as
 * a heading, which is wrong for text read off a screen. Memory's public API exposes no tokenizer
 * either, so the bound here is a proven ceiling rather than a guess. The model's tokenizer is BERT
 * WordPiece: it lowercases and decomposes (NFD) the text, splits it at whitespace, punctuation and
 * CJK characters, then cuts each word into pieces of at least one code point, or one `[UNK]` for a
 * word it can't cut. No token spans whitespace, so the tokens in a text are at most its
 * non-whitespace code points once lowercased and decomposed (`한` decomposes to three jamo and
 * costs three). A chunk may weigh at most `CHUNK_TOKEN_BUDGET`: 512, less the six tokens of
 * `[CLS] search_document: … [SEP]`, less a small margin.
 */
export const CHUNK_TOKEN_BUDGET = 500;

const SPACE = /\s/;

function charWeight(char: string): number {
  if (SPACE.test(char)) return 0;
  // Both orders, since a lowercase can add code points (`İ` → `i̇`) and so can a decomposition.
  return Math.max(
    [...char.toLowerCase().normalize("NFD")].length,
    [...char.normalize("NFD").toLowerCase()].length
  );
}

/** An upper bound on the tokens the embedder makes of `text` (see `CHUNK_TOKEN_BUDGET`). */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const char of text) total += charWeight(char);
  return total;
}

/** Cut one over-budget run into pieces that each fit: at spaces where it can, mid-word only if it must. */
function cutToBudget(run: string): string[] {
  const pieces: string[] = [];
  let current = "";
  let weight = 0;
  const push = (text: string, textWeight: number): void => {
    if (current && weight + textWeight > CHUNK_TOKEN_BUDGET) {
      pieces.push(current);
      current = "";
      weight = 0;
    }
    current += text;
    weight += textWeight;
  };

  for (const word of run.split(/(?<=\s)/)) {
    const wordWeight = estimateTokens(word);
    if (wordWeight <= CHUNK_TOKEN_BUDGET) {
      push(word, wordWeight);
      continue;
    }
    // One unbroken run (a minified blob, a long hash) longer than a whole chunk.
    for (const char of word) push(char, charWeight(char));
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * `windowTitle`, `address` and `body` joined by newlines, then split into chunks that each fit the
 * embedder: whole lines where they fit, a hard cut inside a line that doesn't. Concatenated, the
 * chunks reproduce the joined text apart from trimmed edge whitespace. `lineStart`/`lineEnd` are zero-based line
 * numbers within the joined text. Empty parts are skipped, and an all-empty segment yields no chunk.
 */
export function splitSegmentText(
  windowTitle: string,
  address: string | null,
  body: string
): TextChunk[] {
  const joined = [windowTitle, address ?? "", body].filter((part) => part.trim() !== "").join("\n");
  if (joined.trim() === "") return [];

  const chunks: TextChunk[] = [];
  let current = "";
  let currentWeight = 0;
  let currentStartLine = 0;
  let line = 0;

  const flush = (endLine: number): void => {
    const text = current.trim();
    // `endLine` is the line the next text starts on, one past this chunk when it ends in a newline.
    const lineEnd = Math.max(currentStartLine, current.endsWith("\n") ? endLine - 1 : endLine);
    if (text) chunks.push({ text, lineStart: currentStartLine, lineEnd });
    current = "";
    currentWeight = 0;
  };

  for (const unit of joined.split(/(?<=\n)/)) {
    const pieces = estimateTokens(unit) > CHUNK_TOKEN_BUDGET ? cutToBudget(unit) : [unit];
    for (const piece of pieces) {
      const weight = estimateTokens(piece);
      if (current && currentWeight + weight > CHUNK_TOKEN_BUDGET) {
        flush(line);
      }
      if (!current) currentStartLine = line;
      current += piece;
      currentWeight += weight;
    }
    if (unit.endsWith("\n")) line += 1;
  }
  flush(line);
  return chunks;
}
