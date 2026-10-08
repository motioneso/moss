import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { ConstrainedProcessError } from "./constrained-structured-process.js";
import { CliChatUnavailableError } from "./errors.js";

/** Only published binaries whose tool/config paths were inspected are admitted. */
export const CONSTRAINED_CLAUDE_VERSION = "2.1.282";
export const CONSTRAINED_CLAUDE_SHA256: Readonly<Record<string, string>> = {
  x64: "3afe8535c0cc33f0e24f7b25dab7a1727b8b592196f8496a8bc302ba2161eed3",
  arm64: "6764ffc39e9fed425a493ff61ea28506d1ba83996ce81a48d1177dbb393419c9"
};

/** Advisory installed-version check only: no binary execution, hashing, credential or model I/O. */
export async function findConstrainedClaudeExecutable(
  searchPath = process.env.PATH ?? ""
): Promise<string | undefined> {
  if (process.platform !== "linux" || !CONSTRAINED_CLAUDE_SHA256[process.arch]) return undefined;
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await realpath(join(directory, "claude"));
      await access(executable, constants.X_OK);
      if (!(await stat(executable)).isFile()) continue;
      const metadataPath = join(dirname(executable), "package.json");
      if ((await stat(metadataPath)).size > 16_384) continue;
      const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
      if (
        metadata &&
        typeof metadata === "object" &&
        "name" in metadata &&
        "version" in metadata &&
        metadata.name === `@anthropic-ai/claude-code-linux-${process.arch}` &&
        metadata.version === CONSTRAINED_CLAUDE_VERSION
      )
        return executable;
    } catch {
      /* A missing, stale or unreadable installation is unavailable. */
    }
  }
  return undefined;
}

export async function probeConstrainedClaudeProvider(
  provider: string
): Promise<{ status: "ready" | "not_installed" }> {
  return {
    status:
      provider === "anthropic" && (await findConstrainedClaudeExecutable())
        ? "ready"
        : "not_installed"
  };
}

export class ConstrainedClaudeUnsupportedError extends CliChatUnavailableError {
  constructor() {
    super("Constrained Claude runtime is unsupported");
    this.name = "ConstrainedClaudeUnsupportedError";
  }
}

export interface ConstrainedClaudeProfileOptions {
  /** Existing saved login token; never read from inherited process.env. */
  readonly token: string;
  /** Fresh, private, owner-created per-call home. The caller owns its cleanup. */
  readonly privateHome: string;
  /** Absolute executable from the existing managed installation. */
  readonly executablePath: string;
  readonly model: string | null;
  readonly schema: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface ConstrainedClaudeProfile {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface ConstrainedClaudeProfileDeps {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Test seam. Production reads and hashes the published executable without running it. */
  readonly digest?: (path: string, signal?: AbortSignal) => Promise<string>;
}

async function executableDigest(path: string, signal?: AbortSignal): Promise<string> {
  const stream = createReadStream(path, { signal });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
      if (bytes > 400 * 1024 * 1024) throw new ConstrainedClaudeUnsupportedError();
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    stream.destroy();
  }
}

/** Bounded per-process cache; replacement and same-size/mtime edits invalidate by inode/ctime. */
export function createExecutableDigestCache(
  readDigest: (path: string, signal?: AbortSignal) => Promise<string> = executableDigest,
  capacity = 8
): (path: string, signal?: AbortSignal) => Promise<string> {
  const cache = new Map<string, { fingerprint: string; digest: string }>();
  const fingerprint = async (path: string) => {
    const value = await stat(path, { bigint: true });
    if (!value.isFile() || value.size > 400n * 1024n * 1024n)
      throw new ConstrainedClaudeUnsupportedError();
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode].join(":");
  };
  return async (path, signal) => {
    if (signal?.aborted) throw new ConstrainedProcessError("cancelled");
    const resolved = await realpath(path);
    const before = await fingerprint(resolved);
    const saved = cache.get(resolved);
    if (saved?.fingerprint === before) {
      cache.delete(resolved);
      cache.set(resolved, saved);
      return saved.digest;
    }
    cache.delete(resolved);
    const digest = await readDigest(resolved, signal);
    if (signal?.aborted) throw new ConstrainedProcessError("cancelled");
    if ((await fingerprint(resolved)) !== before) throw new ConstrainedClaudeUnsupportedError();
    cache.set(resolved, { fingerprint: before, digest });
    while (cache.size > Math.max(1, capacity)) cache.delete(cache.keys().next().value!);
    return digest;
  };
}
const cachedExecutableDigest = createExecutableDigestCache();

/**
 * No transcript, login request, account classification, or policy inspection occurs here.
 * Org-managed policy is trusted and outside the transcript-injection boundary.
 */
export async function prepareConstrainedClaudeProfile(
  options: ConstrainedClaudeProfileOptions,
  deps: ConstrainedClaudeProfileDeps = {}
): Promise<ConstrainedClaudeProfile> {
  if (options.signal?.aborted) throw new ConstrainedProcessError("cancelled");
  const expected = CONSTRAINED_CLAUDE_SHA256[deps.arch ?? process.arch];
  if (
    (deps.platform ?? process.platform) !== "linux" ||
    !expected ||
    !isAbsolute(options.executablePath) ||
    !isAbsolute(options.privateHome) ||
    options.privateHome === "/" ||
    !options.token.trim() ||
    [options.executablePath, options.privateHome, options.token, options.model ?? ""].some((s) =>
      s.includes("\0")
    )
  ) {
    throw new ConstrainedClaudeUnsupportedError();
  }
  let digest: string;
  try {
    digest = await (deps.digest ?? cachedExecutableDigest)(options.executablePath, options.signal);
  } catch {
    if (options.signal?.aborted) throw new ConstrainedProcessError("cancelled");
    throw new ConstrainedClaudeUnsupportedError();
  }
  if (options.signal?.aborted) throw new ConstrainedProcessError("cancelled");
  if (digest !== expected) throw new ConstrainedClaudeUnsupportedError();
  let schema: string;
  try {
    schema = JSON.stringify(options.schema);
    if (
      !schema ||
      !options.schema ||
      typeof options.schema !== "object" ||
      Array.isArray(options.schema)
    ) {
      throw new ConstrainedClaudeUnsupportedError();
    }
  } catch {
    throw new ConstrainedClaudeUnsupportedError();
  }
  return {
    command: options.executablePath,
    args: [
      "--print",
      "--safe-mode",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--disable-slash-commands",
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      schema,
      ...(options.model ? ["--model", options.model] : [])
    ],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: options.privateHome,
      CLAUDE_CONFIG_DIR: join(options.privateHome, ".claude"),
      TMPDIR: options.privateHome,
      CLAUDE_CODE_TMPDIR: options.privateHome,
      CLAUDE_CODE_OAUTH_TOKEN: options.token,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  };
}

/** The JSON-schema formatter is an internal output tool, not an executable/MCP capability. */
export function parseConstrainedClaudeOutput(stdout: string): string {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const result = value as Record<string, unknown>;
    if (result.type !== "result" || result.is_error !== false || result.subtype !== "success") {
      throw new Error();
    }
    const candidate: unknown = result.structured_output ?? result.result;
    if (typeof candidate === "string") {
      if (!candidate.trim()) throw new Error();
      return candidate;
    }
    if (candidate === null || typeof candidate !== "object") throw new Error();
    return JSON.stringify(candidate);
  } catch {
    throw new ConstrainedProcessError("protocol");
  }
}
