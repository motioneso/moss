import { MOSS_OPENCODE_API_KEY_ENV } from "@moss/acp";

const MASK = "[redacted]";
const CREDENTIAL_ENV_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  MOSS_OPENCODE_API_KEY_ENV
];

/** The credential values set in an agent's launch environment. */
export function credentialValuesIn(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIAL_ENV_NAMES.map((name) => env[name]).filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

/**
 * Masks every exact copy of each secret in one protocol line, including the
 * JSON-escaped form. An agent that is talked into echoing its credential in
 * plain form never delivers it to the API. A re-encoded copy (split,
 * base64) is not caught.
 */
export function maskSecretsInLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    out = out.split(secret).join(MASK);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(MASK);
  }
  return out;
}
