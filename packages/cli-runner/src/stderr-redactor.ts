import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { redactSecrets } from "@moss/ai";

const MASK = "[redacted]";
const MAX_LOGGED = 2000;

export interface StreamRedactor {
  push(chunk: Buffer): string;
  flush(): string;
}

/**
 * Index where the trailing text could still be the start of `secret`, or `text.length` when no
 * tail can. The holdback is at most `secret.length - 1` characters.
 */
function heldFrom(text: string, secret: string): number {
  const start = Math.max(0, text.length - (secret.length - 1));
  for (let index = start; index < text.length; index += 1) {
    if (secret.startsWith(text.slice(index))) return index;
  }
  return text.length;
}

/**
 * Masks every copy of one secret in a byte stream, including copies split across chunks.
 * `push` returns the text that can no longer be part of a secret and holds the rest. `flush`
 * releases the held text, masking a trailing partial secret.
 */
export function createStreamRedactor(secret: string | undefined): StreamRedactor {
  const decoder = new StringDecoder("utf8");
  if (!secret) return { push: (chunk) => decoder.write(chunk), flush: () => decoder.end() };
  let held = "";
  return {
    push(chunk) {
      const text = (held + decoder.write(chunk)).split(secret).join(MASK);
      const cut = heldFrom(text, secret);
      held = text.slice(cut);
      return text.slice(0, cut);
    },
    flush() {
      const text = (held + decoder.end()).split(secret).join(MASK);
      held = "";
      const cut = heldFrom(text, secret);
      return cut < text.length ? `${text.slice(0, cut)}${MASK}` : text;
    }
  };
}

/** Logs an adapter's stderr with the session secret and generic token patterns masked. */
export function logRedactedStderr(
  stream: Readable,
  secret: string | undefined,
  log: (text: string) => void
): void {
  const redactor = createStreamRedactor(secret);
  const emit = (text: string) => {
    const safe = redactSecrets(text).slice(-MAX_LOGGED);
    if (safe.length > 0) log(safe);
  };
  stream.on("data", (chunk: Buffer) => emit(redactor.push(chunk)));
  stream.on("end", () => emit(redactor.flush()));
}
