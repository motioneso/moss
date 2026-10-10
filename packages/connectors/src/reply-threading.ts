import type { ParsedEmail } from "./email-extract.js";

/** The message metadata a reply needs to thread under this message. */
export function replyThreadingMetadata(parsed: ParsedEmail): {
  messageId?: string;
  references?: string[];
} {
  return {
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    ...(parsed.references && parsed.references.length > 0 ? { references: parsed.references } : {})
  };
}
