// Offline contract check (spec 5.1). Runs the candidate tools, so it only ever runs in the
// no-secrets job. Needs no provider sign-in.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RpcProviderKind } from "@moss/chat/live";
import { checkAgentCapabilities } from "@moss/acp";

import { InstallService } from "../../packages/cli-runner/src/install-service.js";
import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import { createSanitizedTmuxIo } from "../../packages/cli-runner/src/runner-io.js";
import {
  extractLongFlags,
  missingFlags,
  toolsFlagWithMcp,
  type CapturedCommand
} from "./launch-commands.js";
import type { PackageRole } from "./manifest.js";

const execFileAsync = promisify(execFile);

export interface CandidatePackage {
  readonly role: PackageRole;
  readonly pkg: string;
  readonly version: string;
  /** Absolute path of the generated lockfile. */
  readonly lockfilePath: string;
}

export interface ToolsetCandidate {
  readonly toolset: string;
  readonly packages: readonly CandidatePackage[];
}

export interface ContractResult {
  readonly toolset: string;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

const HELP_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Sends ACP `initialize` to a started adapter and returns its response. Kills the adapter. */
export async function acpInitialize(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = HANDSHAKE_TIMEOUT_MS
): Promise<unknown> {
  const child = spawn(command, [...args], { env, stdio: ["pipe", "pipe", "ignore"] });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("adapter did not answer initialize")),
        timeoutMs
      );
      let buffer = "";
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("adapter exited before answering initialize"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (const line of buffer.split("\n")) {
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
            if (msg.id === 1) {
              clearTimeout(timer);
              if (msg.error !== undefined) reject(new Error("adapter returned an error"));
              else resolve(msg.result);
              return;
            }
          } catch {
            /* partial line, keep buffering */
          }
        }
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`
      );
    });
  } finally {
    child.kill("SIGKILL");
  }
}

/** Asserts the adapter's initialize answer meets the real chat capability gate. */
export function checkHandshakeResult(result: unknown): string | null {
  try {
    checkAgentCapabilities("chat", result as Parameters<typeof checkAgentCapabilities>[1]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "adapter failed the capability check";
  }
}

async function binaryPath(pkgDir: string, pkgName: string): Promise<string> {
  const pj = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pj.bin === "string" ? pj.bin : Object.values(pj.bin ?? {})[0];
  if (rel === undefined) throw new Error(`${pkgName} exposes no command`);
  return path.join(pkgDir, rel);
}

/** Installs the adapter's own lockfile into a scratch folder (no scripts) and starts it. */
async function checkAdapter(
  pkg: CandidatePackage,
  toolsetBin: string | undefined
): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "cli-tools-adapter-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "adapter-scratch",
      private: true,
      dependencies: { [pkg.pkg]: pkg.version }
    })
  );
  await copyFile(pkg.lockfilePath, path.join(dir, "package-lock.json"));
  await execFileAsync("npm", ["ci", "--ignore-scripts"], { cwd: dir, timeout: 180_000 });
  const bin = await binaryPath(path.join(dir, "node_modules", pkg.pkg), pkg.pkg);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    ...(toolsetBin === undefined
      ? {}
      : { CLAUDE_CODE_EXECUTABLE: toolsetBin, CODEX_PATH: toolsetBin })
  };
  try {
    const answer = await acpInitialize(process.execPath, [bin], env);
    const problem = checkHandshakeResult(answer);
    return problem === null ? [] : [`${pkg.pkg}: ${problem}`];
  } catch (err) {
    return [`${pkg.pkg}: ${err instanceof Error ? err.message : "handshake failed"}`];
  }
}

async function help(bin: string, subcommand: string | undefined): Promise<string> {
  const args = subcommand === undefined ? ["--help"] : [subcommand, "--help"];
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: HELP_TIMEOUT_MS,
    maxBuffer: 8_000_000
  });
  return `${stdout}\n${stderr}`;
}

export async function runContractCheck(
  candidate: ToolsetCandidate,
  commands: readonly CapturedCommand[]
): Promise<ContractResult> {
  const failures: string[] = [];
  const provider = candidate.toolset as RpcProviderKind;
  const cli = candidate.packages.find((p) => p.role === "cli");
  const entry = PROVIDER_CATALOG[provider];
  if (!cli || entry?.status !== "supported" || entry.recipe?.kind !== "npm") {
    return {
      toolset: candidate.toolset,
      pass: false,
      failures: ["toolset has no installable CLI"]
    };
  }

  const prefix = await mkdtemp(path.join(tmpdir(), "cli-tools-prefix-"));
  const service = new InstallService({
    io: createSanitizedTmuxIo(),
    catalog: {
      ...PROVIDER_CATALOG,
      [provider]: {
        ...entry,
        recipe: { ...entry.recipe, version: cli.version, lockfile: cli.lockfilePath }
      }
    },
    toolsPrefix: prefix,
    homeBase: path.join(prefix, "home")
  });
  const installed = await service.installProvider(provider);
  if (installed.state !== "installed" || installed.version !== cli.version) {
    failures.push(
      `${cli.pkg} did not install at ${cli.version}: ${installed.message ?? installed.state}`
    );
    return { toolset: candidate.toolset, pass: false, failures };
  }
  const bin = path.join(
    prefix,
    "providers",
    provider,
    "current",
    "node_modules",
    ".bin",
    entry.recipe.binary
  );

  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: HELP_TIMEOUT_MS });
    if (!stdout.includes(cli.version))
      failures.push(`--version reports "${stdout.trim()}", not ${cli.version}`);
  } catch (err) {
    failures.push(`--version failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  for (const command of commands.filter((c) => c.provider === candidate.toolset)) {
    if (toolsFlagWithMcp(command.line)) {
      failures.push(`${command.label}: --tools is passed together with the Moss tool server`);
    }
    try {
      const gone = missingFlags(
        extractLongFlags(command.line),
        await help(bin, command.subcommand)
      );
      for (const flag of gone) failures.push(`${command.label}: ${flag} is no longer accepted`);
    } catch (err) {
      failures.push(
        `${command.label}: --help failed: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
  }

  for (const adapter of candidate.packages.filter((p) => p.role === "chat-adapter")) {
    failures.push(...(await checkAdapter(adapter, bin)));
  }
  return { toolset: candidate.toolset, pass: failures.length === 0, failures };
}
