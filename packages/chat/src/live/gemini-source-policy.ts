import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliChatUnavailableError } from "./errors.js";
import { SOURCE_CLI_OUTPUT_BYTES } from "./claude-source-policy.js";

export const GEMINI_SOURCE_RESTRICTIONS = {
  tools: { core: [] },
  // 0.57.0 treats an empty allowlist as unrestricted. The intersection below permits none.
  mcp: { allowed: ["workshop-source-disabled"], excluded: ["workshop-source-disabled"] },
  hooksConfig: { enabled: false },
  privacy: { usageStatisticsEnabled: false },
  telemetry: { enabled: false },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  advanced: { autoConfigureMemory: false },
  admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } }
};

/** The runner must derive this atomic credential record from a fresh actor/config-bound login. */
export async function createGeminiSourceLaunch(
  input: { model?: string; schema: Record<string, unknown>; personaText?: string },
  credentialFile?: string
) {
  const model = input.model;
  if (!credentialFile || !model?.trim() || model !== model.trim() || model === "default") {
    throw new CliChatUnavailableError(
      "Source generation requires a configured model and credential"
    );
  }
  const raw = await readCredentialFile(credentialFile);
  const credential = parseGeminiSourceCredential(JSON.parse(raw));
  const credentialVersion = createHash("sha256").update(raw).digest("hex");
  let acceptedCredential: ReturnType<typeof parseGeminiSourceCredential> | undefined;
  const secrets = [
    credential.oauth.access_token,
    credential.oauth.refresh_token,
    credential.oauth.id_token
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const home = await mkdtemp(join(tmpdir(), "moss-source-gemini-"));
  try {
    const config = join(home, ".gemini");
    const cwd = join(home, "work");
    const temporary = join(home, "tmp");
    for (const path of [config, cwd, temporary]) await mkdir(path, { mode: 0o700 });
    const settings = {
      ...GEMINI_SOURCE_RESTRICTIONS,
      experimental: { dynamicModelConfiguration: true },
      modelConfigs: { modelIdResolutions: { [model]: { default: model, contexts: [] } } }
    };
    const system = join(home, "system-settings.json");
    const defaults = join(home, "system-defaults.json");
    for (const [path, value] of [
      [system, settings],
      [defaults, {}],
      [join(config, "settings.json"), { security: { auth: { selectedType: "oauth-personal" } } }],
      [join(config, "oauth_creds.json"), credential.oauth],
      [join(config, "google_accounts.json"), { active: credential.account, old: [] }]
    ] as const)
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });

    return {
      credentialVersion,
      executable: process.env.JARVIS_CLI_TOOLS_PREFIX
        ? join(process.env.JARVIS_CLI_TOOLS_PREFIX, "bin/gemini")
        : "gemini",
      cwd,
      args: [
        "-p",
        "Return only the source JSON requested on standard input.",
        "-o",
        "stream-json",
        "--approval-mode",
        "yolo",
        "--skip-trust",
        "-m",
        model
      ],
      env: {
        HOME: home,
        NO_BROWSER: "1",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: temporary,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaults
      },
      encodePrompt(text: string): string {
        return `${input.personaText ?? "Produce source data only. Use no tools."}\n\n${text}\n\nReturn a JSON object matching this schema:\n${JSON.stringify(input.schema)}\n`;
      },
      async readResult(output: string): Promise<string> {
        acceptedCredential = undefined;
        try {
          const refreshed = await readGeminiNativeCredential(home);
          if (refreshed.account !== credential.account)
            throw new Error("Credential account changed");
          const currentSecrets = [
            refreshed.oauth.access_token,
            refreshed.oauth.refresh_token,
            refreshed.oauth.id_token
          ].filter((value): value is string => typeof value === "string" && value.length > 0);
          if (
            Buffer.byteLength(output) > SOURCE_CLI_OUTPUT_BYTES ||
            [...secrets, ...currentSecrets].some(
              (secret) =>
                output.includes(secret) || output.includes(JSON.stringify(secret).slice(1, -1))
            )
          ) {
            throw new Error("Protected or oversized output");
          }
          const records = output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          if (
            records.some(
              (record) => !record || !["init", "message", "result"].includes(record.type)
            )
          ) {
            throw new Error("Unexpected provider activity");
          }
          const init = records.filter((record) => record.type === "init");
          const result = records.filter((record) => record.type === "result");
          if (
            init.length !== 1 ||
            init[0].model !== model ||
            records[0] !== init[0] ||
            result.length !== 1 ||
            result[0].status !== "success" ||
            result[0].error ||
            records.at(-1) !== result[0]
          )
            throw new Error("Missing successful source completion");
          const messages = records.filter((record) => record.type === "message");
          if (
            messages.some(
              (record) =>
                !["assistant", "user"].includes(record.role) || typeof record.content !== "string"
            )
          ) {
            throw new Error("Invalid source message");
          }
          const value: unknown = JSON.parse(
            messages
              .filter((record) => record.role === "assistant")
              .map((record) => record.content)
              .join("")
          );
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Invalid source object");
          const normalized = JSON.stringify(value);
          if (
            [...secrets, ...currentSecrets].some(
              (secret) =>
                normalized.includes(secret) ||
                normalized.includes(JSON.stringify(secret).slice(1, -1))
            )
          )
            throw new Error("Protected output");
          acceptedCredential = refreshed;
          return normalized;
        } catch {
          throw new CliChatUnavailableError("Source generation response failed policy validation");
        }
      },
      async readRefreshedCredential() {
        try {
          if (!acceptedCredential) throw new Error("Source result has not been accepted");
          return acceptedCredential;
        } catch {
          throw new CliChatUnavailableError("Source generation credential is unavailable");
        }
      },
      dispose: () => rm(home, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

async function readCredentialFile(path: string): Promise<string> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Not a credential file");
      const buffer = Buffer.alloc(SOURCE_CLI_OUTPUT_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > SOURCE_CLI_OUTPUT_BYTES) throw new Error("Oversized credential");
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      JSON.parse(text);
      return text;
    } finally {
      await file.close();
    }
  } catch {
    throw new CliChatUnavailableError("Source generation credential is unavailable");
  }
}

/** Shared by private launch-state consumption and runner-owned atomic publication. */
export function parseGeminiSourceCredential(input: unknown) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid record");
    const value = input as Record<string, unknown>;
    if (!value.oauth || typeof value.oauth !== "object" || Array.isArray(value.oauth))
      throw new Error("Invalid OAuth record");
    const oauth = value.oauth as Record<string, unknown>;
    if (
      typeof value.account !== "string" ||
      !value.account.includes("@") ||
      typeof oauth.access_token !== "string" ||
      !oauth.access_token.trim() ||
      typeof oauth.refresh_token !== "string" ||
      !oauth.refresh_token.trim() ||
      oauth.token_type !== "Bearer" ||
      typeof oauth.expiry_date !== "number" ||
      !Number.isFinite(oauth.expiry_date) ||
      oauth.expiry_date <= 0 ||
      Object.keys(value).some((key) => !["account", "oauth"].includes(key)) ||
      Object.keys(oauth).some(
        (key) =>
          ![
            "access_token",
            "refresh_token",
            "token_type",
            "expiry_date",
            "scope",
            "id_token"
          ].includes(key)
      ) ||
      [oauth.scope, oauth.id_token].some(
        (field) => field !== undefined && typeof field !== "string"
      )
    )
      throw new Error("Invalid credential record");
    const record = {
      account: value.account,
      oauth: {
        access_token: oauth.access_token,
        refresh_token: oauth.refresh_token,
        token_type: "Bearer" as const,
        expiry_date: oauth.expiry_date,
        ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
        ...(typeof oauth.id_token === "string" ? { id_token: oauth.id_token } : {})
      }
    };
    if (Buffer.byteLength(JSON.stringify(record)) > SOURCE_CLI_OUTPUT_BYTES)
      throw new Error("Oversized credential");
    return record;
  } catch {
    throw new CliChatUnavailableError("Source generation credential is unavailable");
  }
}

/** Read only native state in a caller-owned private HOME, never ambient provider state. */
export async function readGeminiNativeCredential(home: string) {
  const config = join(home, ".gemini");
  const account = JSON.parse(await readCredentialFile(join(config, "google_accounts.json")));
  return parseGeminiSourceCredential({
    account: account?.active,
    oauth: JSON.parse(await readCredentialFile(join(config, "oauth_creds.json")))
  });
}
