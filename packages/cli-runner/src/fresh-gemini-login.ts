import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GEMINI_SOURCE_RESTRICTIONS, readGeminiNativeCredential } from "@moss/chat/live";
import type { ProviderLoginScope } from "@moss/shared";
import { publishFreshCredentialFiles } from "./fresh-cli-login.js";
import { scopedGeminiCredentialPath } from "./gemini-credential-store.js";
import { ensureGeminiOnboarded } from "./provider-first-run.js";

export function freshGeminiEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TERM: "xterm-256color",
    NO_BROWSER: "1",
    TMPDIR: path.join(home, "tmp"),
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, "system-settings.json"),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(home, "system-defaults.json")
  };
}

export async function prepareFreshGeminiLogin(home: string): Promise<void> {
  for (const dir of [".gemini", "tmp"])
    await mkdir(path.join(home, dir), { recursive: true, mode: 0o700 });
  for (const [file, value] of [
    ["system-settings.json", GEMINI_SOURCE_RESTRICTIONS],
    ["system-defaults.json", {}],
    [".gemini/settings.json", { security: { auth: { selectedType: "oauth-personal" } } }]
  ] as const)
    await writeFile(path.join(home, file), JSON.stringify(value), { mode: 0o600, flag: "wx" });
}

/** Validate native fresh-login identity without selecting a feature model or using global readiness. */
export async function validateFreshGeminiCredential(home: string, signal: AbortSignal) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const credential = await readGeminiNativeCredential(home);
    if (signal.aborted || credential.oauth.expiry_date <= Date.now()) return undefined;
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${credential.oauth.access_token}` },
      redirect: "error",
      signal: AbortSignal.any([signal, abort.signal])
    });
    reader = response.body?.getReader();
    if (!response.ok || !reader) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16_384) return undefined;
      chunks.push(part.value);
    }
    const account: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !signal.aborted &&
      !abort.signal.aborted &&
      account &&
      typeof account === "object" &&
      "email" in account &&
      account.email === credential.account &&
      "verified_email" in account &&
      account.verified_email === true
    )
      return credential;
  } catch {
    // Native state, OAuth responses and errors may contain secrets; expose only failure.
  } finally {
    clearTimeout(timer);
    abort.abort();
    await reader?.cancel().catch(() => undefined);
  }
  return undefined;
}

export async function publishFreshGeminiCredential(
  homeBase: string,
  scope: ProviderLoginScope,
  credential: NonNullable<Awaited<ReturnType<typeof validateFreshGeminiCredential>>>,
  isCurrent: () => boolean,
  onPublished: () => void
): Promise<void> {
  await ensureGeminiOnboarded(homeBase);
  await publishFreshCredentialFiles(
    [
      [path.join(homeBase, ".gemini", "oauth_creds.json"), JSON.stringify(credential.oauth)],
      [
        path.join(homeBase, ".gemini", "google_accounts.json"),
        JSON.stringify({ active: credential.account, old: [] })
      ],
      [scopedGeminiCredentialPath(homeBase, scope), JSON.stringify(credential)]
    ],
    isCurrent,
    onPublished
  );
}
