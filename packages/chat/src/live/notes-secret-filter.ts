/**
 * Fail-closed credential/secret shape detector for notes recall (#1556 Task 3). Runs in chat,
 * not `@moss/notes` — notes are allowed to store credential-shaped text, chat is never allowed
 * to inject it into a prompt. A match means the snippet is dropped entirely by the retriever
 * (Task 5), never truncated-and-kept.
 *
 * `Bearer `/`Authorization:` are treated as self-sufficient credential shapes (that is what they
 * are, by definition). `api_key`/`secret` are common English/config words on their own, so they
 * only count when a long base64/hex-looking run sits near them — otherwise "the secret to
 * happiness" or "api_key field in the schema" would false-positive.
 */

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PASSWORD_ASSIGNMENT = /\bpassword\s*[:=]\s*\S{3,}/i;
const BEARER_TOKEN = /\bBearer\s+\S{8,}/i;
const AUTHORIZATION_HEADER = /\bAuthorization\s*:\s*\S+/i;
const LONG_TOKEN_NEAR_KEYWORD = /\b(?:api[_-]?key|secret)\b[^\n]{0,20}[A-Za-z0-9+/_-]{20,}={0,2}/i;
const ENV_SECRET_ASSIGNMENT = /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*\S+/;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  PEM_PRIVATE_KEY,
  PASSWORD_ASSIGNMENT,
  BEARER_TOKEN,
  AUTHORIZATION_HEADER,
  LONG_TOKEN_NEAR_KEYWORD,
  ENV_SECRET_ASSIGNMENT
];

export function isCredentialShaped(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}
