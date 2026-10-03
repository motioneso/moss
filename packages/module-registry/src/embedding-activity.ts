import type { ModelActivityEntry, ModelActivityRecorder } from "@moss/ai";
import type { EmbeddingActivityEntry } from "@moss/memory";

/**
 * #2956 slice B: embedding rows enter through the memory sink, which cannot
 * name `@moss/ai` line codes. The forward maps the wrap site's source onto
 * the `embed.<source>` code and carries the owner; the memory-only `source`
 * field is dropped so only recorded columns travel. A sourceless line keeps
 * no code — the page titles it as a generic embedding line.
 */
export function mapEmbeddingActivityEntry(entry: EmbeddingActivityEntry): ModelActivityEntry {
  const { source, ...rest } = entry;
  return {
    ...rest,
    ...(source ? { actionCode: `embed.${source}` } : {})
  };
}

/** Forward one embedding entry to the DB recorder with its line code. */
export function forwardEmbeddingActivity(
  recorder: ModelActivityRecorder
): (entry: EmbeddingActivityEntry) => void {
  return (entry) => recorder(mapEmbeddingActivityEntry(entry));
}
