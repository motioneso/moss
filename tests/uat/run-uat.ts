import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, matchesGlob } from "node:path";
import { provisionForUat } from "./provisioner.js";
import type { UatChatScript, UatSeedChunk, UatSeedLevel } from "./seed/types.js";
import { UAT_CHAT_SCRIPTS } from "./seed/types.js";

const SPEC_DIR = "tests/uat/specs";
const LEVELS = new Set<UatSeedLevel>(["bare", "solo-admin", "admin+data", "multi-user"]);
const CHUNKS = new Set<UatSeedChunk>(["news", "sports", "tasks", "calendar", "notes", "finance"]);
const CHAT_SCRIPTS = new Set<UatChatScript>(UAT_CHAT_SCRIPTS);

async function resolveSpecPaths(filters: readonly string[]): Promise<string[]> {
  const available = (await readdir(SPEC_DIR))
    .filter((file) => file.endsWith(".uat.spec.ts"))
    .map((file) => join(SPEC_DIR, file));
  if (filters.length === 0) return available;

  const matchesFilter = (path: string, filter: string) =>
    path === filter ||
    matchesGlob(path, filter) ||
    matchesGlob(basename(path), filter) ||
    basename(path).includes(filter);

  // #2164: iterate filters in the caller's order, not readdir's filesystem order, so
  // e.g. `run-uat.ts b.spec a.spec` runs b before a. main() exits on the first spec
  // failure, so filesystem order silently skipped later-ordered specs (runtime-context
  // never ran because it sorted after a spec that failed first).
  const selected: string[] = [];
  const remaining = new Set(available);
  for (const filter of filters) {
    for (const path of remaining) {
      if (matchesFilter(path, filter)) {
        selected.push(path);
        remaining.delete(path);
      }
    }
  }
  if (selected.length === 0) {
    throw new Error(`no UAT spec matched: ${filters.join(", ")}`);
  }
  return selected;
}

async function readUatLevel(specPath: string): Promise<{
  level: UatSeedLevel;
  without: readonly UatSeedChunk[];
  withoutNewsJsonBinding: boolean;
  // #1306 Task 22: the spec-side half of provisioner.ts's UatProvisionOptions.withJobSearchFixture
  // (opt-in plumbing landed by #41-46; deliberately left unthreaded from any caller until this
  // task's own spec needed it — see that field's doc comment). Same shape as
  // withoutNewsJsonBinding immediately above: an optional trailing `key: true|false` on the
  // uatLevel literal, parsed by the same regex rather than a second one, so a spec can carry
  // either, both, or neither without this function growing a second code path.
  withJobSearchFixture: boolean;
  withSportsPublicSourceFixtures: boolean;
  withWorkflowApprovalFixture: boolean;
  // #1121 Task 4: same trailing-optional-key pattern as withJobSearchFixture above — an id from
  // UAT_CHAT_SCRIPTS, parsed by the same regex rather than a second one.
  chatScript: UatChatScript | undefined;
}> {
  const source = await readFile(specPath, "utf8");
  const match = source.match(
    /export\s+const\s+uatLevel\s*=\s*\{\s*level:\s*["']([^"']+)["']\s*,\s*without:\s*\[([^\]]*)\]\s*(?:,\s*withoutNewsJsonBinding:\s*(true|false))?\s*(?:,\s*withJobSearchFixture:\s*(true|false))?\s*(?:,\s*withSportsPublicSourceFixtures:\s*(true|false))?\s*(?:,\s*withWorkflowApprovalFixture:\s*(true|false))?\s*(?:,\s*chatScript:\s*["']([a-zA-Z0-9_-]+)["'])?\s*\}\s+as const/
  );
  const level = match?.[1];
  const withoutSource = match?.[2];
  const withoutNewsJsonBindingSource = match?.[3];
  const withJobSearchFixtureSource = match?.[4];
  const withSportsPublicSourceFixturesSource = match?.[5];
  const withWorkflowApprovalFixtureSource = match?.[6];
  const chatScriptSource = match?.[7];
  if (!level || withoutSource === undefined) {
    throw new Error(`${specPath} must export uatLevel per harness spec §5`);
  }

  const without = [...withoutSource.matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string);
  if (!LEVELS.has(level as UatSeedLevel)) {
    throw new Error(`${specPath} has invalid uatLevel.level: ${level}`);
  }
  const invalidChunk = without.find((chunk) => !CHUNKS.has(chunk as UatSeedChunk));
  if (invalidChunk) {
    throw new Error(`${specPath} has invalid uatLevel.without chunk: ${invalidChunk}`);
  }
  if (chatScriptSource !== undefined && !CHAT_SCRIPTS.has(chatScriptSource as UatChatScript)) {
    throw new Error(`${specPath} has invalid uatLevel.chatScript: ${chatScriptSource}`);
  }
  return {
    level: level as UatSeedLevel,
    without: without as UatSeedChunk[],
    withoutNewsJsonBinding: withoutNewsJsonBindingSource === "true",
    withJobSearchFixture: withJobSearchFixtureSource === "true",
    withSportsPublicSourceFixtures: withSportsPublicSourceFixturesSource === "true",
    withWorkflowApprovalFixture: withWorkflowApprovalFixtureSource === "true",
    chatScript: chatScriptSource as UatChatScript | undefined
  };
}

async function runSpec(specPath: string): Promise<number> {
  const uatLevel = await readUatLevel(specPath);
  const { baseURL, projectName, teardown } = await provisionForUat(uatLevel.level, {
    excludeChunks: uatLevel.without,
    withoutNewsJsonBinding: uatLevel.withoutNewsJsonBinding,
    withJobSearchFixture: uatLevel.withJobSearchFixture,
    withSportsPublicSourceFixtures: uatLevel.withSportsPublicSourceFixtures,
    withWorkflowApprovalFixture: uatLevel.withWorkflowApprovalFixture,
    chatScript: uatLevel.chatScript
  });

  const onSignal = () => {
    void teardown().finally(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    console.log(`[uat] running ${specPath} against ${baseURL} (project ${projectName})`);
    return await new Promise<number>((resolvePromise) => {
      const child = spawn(
        "npx",
        ["playwright", "test", "--config=tests/uat/playwright.uat.config.ts", specPath],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            JARVIS_UAT_BASE_URL: baseURL,
            JARVIS_UAT_PROJECT_NAME: projectName
          }
        }
      );
      child.on("exit", (code) => resolvePromise(code ?? 1));
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await teardown();
  }
}

async function main(): Promise<void> {
  const specPaths = await resolveSpecPaths(process.argv.slice(2));
  for (const specPath of specPaths) {
    const exitCode = await runSpec(specPath);
    if (exitCode !== 0) process.exit(exitCode);
  }
}

await main();
