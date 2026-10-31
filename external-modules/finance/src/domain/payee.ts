// Browser-safe: web code reaches this through the bill suggestion types, so it must not import
// node builtins.

/**
 * Payee normalization for categorization rules (FIN-02): lowercase, strip
 * digits and punctuation, collapse whitespace runs — "Trader Joe's #123 "
 * and "TRADER JOES 456" both key the same rule.
 */
export function normalizePayee(name: string): string {
  return name
    .toLowerCase()
    .replace(/[0-9]/gu, "")
    .replace(/[^\p{L}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
