/**
 * #2689: the offline contract check for one candidate toolset (spec 2026-09-25 section 5.1).
 * Needs no provider sign-in.
 *
 *   1. Install the CLI through the real InstallService into a scratch tools folder, then install
 *      it again so the idempotent path re-verifies the on-disk sha512.
 *   2. Check the self-update switch the catalog relies on still appears in the new build.
 *   3. Run each help surface Moss uses and check every flag and subcommand still exists.
 *   4. Install the chat adapter from its lockfile, point it at the new CLI, and complete the ACP
 *      `initialize` handshake through Moss's own capability check.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  checkAgentCapabilities,
  ndJsonStream,
  type AcpClientHandler
} from "@moss/acp";
import type { CatalogEntry, NpmInstallRecipe, ProviderCatalog } from "@moss/chat/live";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import {
  CLI_FLAG_CONTRACTS,
  UNKNOWN_FLAG_RE,
  helpMentionsCommand,
  helpMentionsFlag
} from "../../packages/cli-runner/src/cli-tools/flag-contract.js";
import type { CliToolsetId } from "../../packages/cli-runner/src/cli-tools/toolsets.js";
import { InstallService } from "../../packages/cli-runner/src/install-service.js";
import { createSanitizedTmuxIo } from "../../packages/cli-runner/src/runner-io.js";

const COMMAND_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** A flag no CLI has. Added on request to prove a broken contract blocks a toolset. */
export const DELIBERATELY_BROKEN_FLAG = "--moss-contract-self-test";

export interface ContractCandidate {
  readonly toolset: CliToolsetId;
  readonly cli: { readonly pkg: string; readonly version: string; readonly lockfilePath: string };
  readonly adapter?: {
    readonly pkg: string;
    readonly version: string;
    readonly lockfilePath: string;
  };
  readonly workDir: string;
  readonly breakContract?: boolean;
}

interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd?: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < 1_000_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function catalogWith(toolset: CliToolsetId, recipe: NpmInstallRecipe): ProviderCatalog {
  const entry: CatalogEntry = { provider: toolset, status: "supported", recipe };
  return Object.freeze({ ...PROVIDER_CATALOG, [toolset]: entry }) as ProviderCatalog;
}

/** True when any file under `root` contains `marker`. Streams, so large native binaries are fine. */
async function treeContains(root: string, marker: string): Promise<boolean> {
  const needle = Buffer.from(marker, "utf8");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) {
        if (name !== "node_modules") stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (await fileContains(full, needle)) return true;
    }
  }
  return false;
}

async function fileContains(file: string, needle: Buffer): Promise<boolean> {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const window = Buffer.concat([tail, chunk as Buffer]);
    if (window.includes(needle)) return true;
    tail = window.subarray(Math.max(0, window.length - needle.length + 1));
  }
  return false;
}

/** The names the self-update switch depends on: the env var, or the config file's keys. */
export function selfUpdateMarkers(recipe: NpmInstallRecipe): string[] {
  const sud = recipe.selfUpdateDisable;
  if (sud.kind === "env") return [sud.key];
  if (sud.path.endsWith(".json")) {
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        if (typeof inner === "object" && inner !== null) walk(inner);
        else keys.push(key);
      }
    };
    walk(JSON.parse(sud.content));
    return keys;
  }
  return [...sud.content.matchAll(/^\s*([A-Za-z0-9_]+)\s*=/gm)].map((match) => match[1]!);
}

async function checkCli(candidate: ContractCandidate, problems: string[]): Promise<string | null> {
  const base = PROVIDER_CATALOG[candidate.toolset].recipe;
  if (!base || base.kind !== "npm" || base.pkg !== candidate.cli.pkg) {
    problems.push(`the image catalog has no npm recipe for ${candidate.cli.pkg}`);
    return null;
  }
  const recipe: NpmInstallRecipe = {
    ...base,
    version: candidate.cli.version,
    lockfile: path.resolve(candidate.cli.lockfilePath)
  };
  const toolsPrefix = path.join(candidate.workDir, "tools");
  const homeBase = path.join(candidate.workDir, "home");
  await mkdir(toolsPrefix, { recursive: true });
  await mkdir(homeBase, { recursive: true });
  const env = { ...process.env, HOME: homeBase };
  const service = new InstallService({
    io: createSanitizedTmuxIo(env),
    catalog: catalogWith(candidate.toolset, recipe),
    toolsPrefix,
    homeBase,
    env,
    installTimeoutMs: 600_000
  });

  const first = await service.installProvider(candidate.toolset);
  if (first.state !== "installed" || first.version !== candidate.cli.version) {
    problems.push(`install failed: ${first.message ?? `state ${first.state}`}`);
    return null;
  }
  const again = await service.installProvider(candidate.toolset);
  if (again.state !== "installed") {
    problems.push(`re-verify of the installed files failed: ${again.message ?? again.state}`);
    return null;
  }

  const releaseDir = await realpath(
    path.join(toolsPrefix, "providers", candidate.toolset, "current")
  );
  for (const marker of selfUpdateMarkers(recipe)) {
    if (!(await treeContains(path.join(releaseDir, "node_modules"), marker))) {
      problems.push(`self-update switch "${marker}" no longer appears in the new build`);
    }
  }

  const binary = path.join(toolsPrefix, "bin", recipe.binary);
  const cliEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeBase,
    [selfUpdateEnvKey(recipe)]: "1"
  };
  const contract = CLI_FLAG_CONTRACTS.find((entry) => entry.toolset === candidate.toolset);
  for (const [index, surface] of (contract?.surfaces ?? []).entries()) {
    const help = await run(binary, [...surface.subcommand, "--help"], cliEnv, homeBase);
    const flags =
      candidate.breakContract && index === 0
        ? [...surface.flags, DELIBERATELY_BROKEN_FLAG]
        : surface.flags;
    for (const flag of flags) {
      if (!helpMentionsFlag(help.output, flag))
        problems.push(`"${surface.label}" no longer lists ${flag}`);
    }
    for (const command of surface.commands ?? []) {
      if (!helpMentionsCommand(help.output, command)) {
        problems.push(`"${surface.label}" no longer has the ${command} command`);
      }
    }
    for (const probe of surface.hiddenFlagProbes ?? []) {
      const result = await run(binary, probe.argv, cliEnv, homeBase);
      if (UNKNOWN_FLAG_RE.test(result.output)) {
        problems.push(`"${surface.label}" rejects ${probe.flag} as unknown`);
      }
    }
  }
  return binary;
}

function selfUpdateEnvKey(recipe: NpmInstallRecipe): string {
  return recipe.selfUpdateDisable.kind === "env"
    ? recipe.selfUpdateDisable.key
    : "DISABLE_AUTOUPDATER";
}

const EXECUTABLE_OVERRIDE: Partial<Record<CliToolsetId, string>> = {
  anthropic: "CLAUDE_CODE_EXECUTABLE",
  "openai-compatible": "CODEX_PATH"
};

async function checkAdapter(
  candidate: ContractCandidate,
  cliBinary: string,
  problems: string[]
): Promise<void> {
  const adapter = candidate.adapter!;
  const dir = path.join(candidate.workDir, "adapter");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "npm-shrinkwrap.json"), await readFile(adapter.lockfilePath));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "moss-adapter-check",
      version: "0.0.0",
      dependencies: { [adapter.pkg]: adapter.version }
    })
  );
  const homeBase = path.join(candidate.workDir, "home");
  const npmEnv = { ...process.env, HOME: homeBase };
  const ci = await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], npmEnv, dir);
  if (ci.code !== 0) {
    problems.push(`chat adapter install failed: ${ci.output.slice(-400)}`);
    return;
  }

  const pkgDir = path.join(dir, "node_modules", adapter.pkg);
  const pkgJson = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (pkgJson.version !== adapter.version) {
    problems.push(
      `chat adapter resolved to ${pkgJson.version ?? "?"}, expected ${adapter.version}`
    );
    return;
  }
  const binField =
    typeof pkgJson.bin === "string" ? pkgJson.bin : Object.values(pkgJson.bin ?? {})[0];
  if (!binField) {
    problems.push("chat adapter package has no entry point");
    return;
  }

  const overrideKey = EXECUTABLE_OVERRIDE[candidate.toolset];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homeBase,
    DISABLE_AUTOUPDATER: "1",
    ...(overrideKey ? { [overrideKey]: await realpath(cliBinary) } : {})
  };
  const child = spawn(process.execPath, [path.join(pkgDir, binField)], {
    env,
    cwd: homeBase,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 20_000) stderr += chunk.toString("utf8");
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  const client: AcpClientHandler = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => undefined
  };
  const connection = new ClientSideConnection(() => client, stream);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const init = await Promise.race([
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "moss", version: "0.1.0" }
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("no initialize answer within 60 s")),
          HANDSHAKE_TIMEOUT_MS
        );
      })
    ]);
    checkAgentCapabilities("chat", init);
  } catch (error) {
    problems.push(
      `chat adapter handshake failed: ${(error as Error).message}${stderr ? ` (stderr: ${stderr.slice(-300)})` : ""}`
    );
  } finally {
    if (timer) clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

/** Returns every problem found; an empty list means the toolset passed. */
export async function runContractCheck(candidate: ContractCandidate): Promise<string[]> {
  const problems: string[] = [];
  const cliBinary = await checkCli(candidate, problems);
  if (cliBinary && candidate.adapter) await checkAdapter(candidate, cliBinary, problems);
  return problems;
}
