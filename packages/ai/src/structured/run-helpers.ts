// Internal to @moss/ai: not re-exported from the package index.

export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // The losing promise may still reject later; swallow it so it is never unhandled.
      work.catch(() => undefined);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/**
 * #1888: a CLI-backed adapter returns whatever the CLI printed, and the Claude CLI wraps its answer
 * in a markdown code fence even when the prompt says "No markdown or commentary" — and it does so
 * again on every repair retry, so the repair loop can never talk it out of the fence. Unwrap a
 * reply that is entirely one fenced block; anything else is passed through untouched so genuinely
 * malformed output still fails and goes through repair. Deliberately NOT a "find the JSON-looking
 * part of any text" scrape: that would silently accept a reply whose prose changed its meaning.
 */
export function unfence(rawText: string): string {
  const match = /^\s*```[A-Za-z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(rawText);
  return match ? match[1]! : rawText;
}
