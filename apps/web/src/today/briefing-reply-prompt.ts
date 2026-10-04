/**
 * The reply prompt takes ONLY the opaque cache id. Row titles, explanations, senders and summaries
 * are model-authored or sender-controlled; interpolating any of them here would let a crafted email
 * rewrite the instruction the assistant receives.
 */
export function buildReplyChatPrompt(cacheMessageId: string): string {
  return `Draft a reply to the cached email ${cacheMessageId} using email.draftReply.`;
}
