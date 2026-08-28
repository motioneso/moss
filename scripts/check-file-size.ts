import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { resolveMossEnv } from "@moss/db";

const maxLines = Number(resolveMossEnv(process.env, "JARVIS_MAX_SOURCE_LINES") ?? 1000);
const rootDirectory = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".claude",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "Jarvis Design System",
  "node_modules",
  "playwright-report",
  "test-results"
]);
const ignoredFiles = new Set(["pnpm-lock.yaml"]);
const exemptFiles = new Set<string>([
  "packages/ai/src/repository.ts",
  "packages/ai/src/routes.ts",
  "apps/web/src/api/client.ts",
  // #2050 keeps the Sports story registration contract and its cross-surface composition in
  // these files; the browser slice must stack on that dependency without rewriting its server.
  "packages/sports/src/sports-service.ts",
  "tests/unit/sports-service.test.ts",
  "packages/module-registry/src/index.ts",
  // Hand-maintained Kysely table types; grows with schema, not refactorable smaller.
  "packages/db/src/types.ts"
]);
const checkedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx"
]);

interface FileSizeViolation {
  readonly path: string;
  readonly lines: number;
}

const violations: FileSizeViolation[] = [];

for await (const filePath of walk(rootDirectory)) {
  if (!shouldCheckFile(filePath)) {
    continue;
  }

  const contents = await readFile(filePath, "utf8");
  const lines = countLines(contents);

  if (lines > maxLines) {
    violations.push({
      path: relative(rootDirectory, filePath),
      lines
    });
  }
}

if (violations.length > 0) {
  console.error(`Files over ${maxLines} lines:`);
  for (const violation of violations) {
    console.error(`- ${violation.path}: ${violation.lines}`);
  }
  process.exitCode = 1;
} else {
  console.log(`No checked files exceed ${maxLines} lines.`);
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      yield* walk(join(directory, entry.name));
      continue;
    }

    if (entry.isFile()) {
      yield join(directory, entry.name);
    }
  }
}

function shouldCheckFile(filePath: string): boolean {
  const fileName = relative(rootDirectory, filePath);

  if (ignoredFiles.has(fileName) || exemptFiles.has(fileName)) {
    return false;
  }

  return checkedExtensions.has(extname(filePath));
}

function countLines(contents: string): number {
  const trimmedFinalNewline = contents.replace(/\r?\n$/, "");

  if (trimmedFinalNewline.length === 0) {
    return 0;
  }

  return trimmedFinalNewline.split(/\r\n|\r|\n/).length;
}
