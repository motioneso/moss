import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CREDS_IN_URL } from "./host-diagnostics.js";

export const SOURCE_INSPECTOR_LIMITS = {
  maxMatches: 10,
  maxFilesScanned: 2000,
  maxExcerptLines: 40,
  maxExcerptBytes: 4096,
  maxResponseBytes: 32768,
  maxFileBytes: 524288
} as const;

export const SOURCE_INSPECTOR_ALLOWED_ROOTS = [
  "packages",
  "apps",
  "scripts",
  "infra/postgres",
  "tests",
  "docs"
] as const;

export const SOURCE_INSPECTOR_EXCLUDED_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".cache",
  ".superpowers",
  "external-modules",
  "data",
  "vaults",
  ".claude"
] as const;

const EXCLUDED_NAMES = new Set(["pnpm-lock.yaml"]);
const EXCLUDED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".zip",
  ".tar",
  ".gz"
]);
const SECRET_ASSIGNMENT =
  /\b[\w-]*(?:key|secret|token|password|passwd|credential|api[_-]?key)[\w-]*\b\s*[:=]\s*(?:["'`]([^"'`\r\n]{16,})["'`]|([A-Za-z0-9_./+=:-]{16,}))/i;
const PLACEHOLDER = /^(?:changeme|example|process\.env\b)|<[^>]*>/i;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface SourceExcerpt {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface SourceSearchResult {
  readonly matches: readonly SourceExcerpt[];
  readonly filesScanned: number;
  readonly truncated: boolean;
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
}

export interface SourceInspector {
  search(input: {
    query: string;
    pathPrefix?: string;
    limit?: number;
  }): Promise<SourceSearchResult>;
  read(input: { path: string; startLine?: number; lineCount?: number }): Promise<SourceExcerpt>;
}

interface ResolvedPath {
  readonly absolute: string;
  readonly relative: string;
}

function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate pnpm-workspace.yaml above ${startDir}`);
}

function isContained(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isAllowedRelative(relativePath: string): boolean {
  const parts = relativePath.split(sep).filter(Boolean);
  if (
    parts.length === 0 ||
    SOURCE_INSPECTOR_EXCLUDED_SEGMENTS.some((segment) => parts.includes(segment))
  ) {
    return false;
  }
  if (parts[0] === "infra") return parts[1] === "postgres";
  return SOURCE_INSPECTOR_ALLOWED_ROOTS.includes(
    parts[0] as (typeof SOURCE_INSPECTOR_ALLOWED_ROOTS)[number]
  );
}

function isExcludedFile(relativePath: string): boolean {
  const name = relativePath.split(sep).at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.") || EXCLUDED_NAMES.has(name)) return true;
  const lowerName = name.toLowerCase();
  for (const extension of EXCLUDED_EXTENSIONS) {
    if (lowerName.endsWith(extension)) return true;
  }
  return false;
}

function rejectReason(text: string): string | null {
  if (CREDS_IN_URL.test(text)) return "excerpt contains credentials in a URL";
  const assignment = SECRET_ASSIGNMENT.exec(text);
  if (assignment) {
    const value = assignment[1] ?? assignment[2] ?? "";
    if (!PLACEHOLDER.test(value) && !/^(?:process\.env\b)/i.test(value)) {
      return "excerpt contains a secret-looking assignment";
    }
  }
  if (text.includes("-----BEGIN")) return "excerpt contains a private key header";
  return null;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function excerptFromLines(
  relativePath: string,
  lines: readonly string[],
  startLine: number,
  requestedLineCount: number
): SourceExcerpt {
  const selected: string[] = [];
  for (const line of lines.slice(startLine - 1, startLine - 1 + requestedLineCount)) {
    const next = [...selected, line].join("\n");
    if (
      selected.length >= SOURCE_INSPECTOR_LIMITS.maxExcerptLines ||
      utf8Bytes(next) > SOURCE_INSPECTOR_LIMITS.maxExcerptBytes
    ) {
      break;
    }
    selected.push(line);
  }
  const text = selected.join("\n");
  return {
    path: relativePath,
    startLine,
    endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
    text
  };
}

function responseFits(result: SourceSearchResult): boolean {
  return utf8Bytes(JSON.stringify(result)) <= SOURCE_INSPECTOR_LIMITS.maxResponseBytes;
}

export function createSourceInspector(options: { workspaceRoot?: string } = {}): SourceInspector {
  const root = resolve(options.workspaceRoot ?? findWorkspaceRoot(MODULE_DIR));
  const rootReal = realpathSync(root);

  function resolvePath(inputPath: string, allowRoot = false): ResolvedPath {
    if (!inputPath || isAbsolute(inputPath)) throw new Error("source path must be relative");
    const absolute = resolve(root, inputPath);
    if (!isContained(absolute, root) || (!allowRoot && absolute === root)) {
      throw new Error("source path is outside the workspace");
    }
    const real = realpathSync(absolute);
    if (!isContained(real, rootReal)) throw new Error("source path resolves outside the workspace");
    const relativePath = relative(root, absolute);
    if (!relativePath && allowRoot) return { absolute: real, relative: relativePath };
    if (!isAllowedRelative(relativePath) || isExcludedFile(relativePath)) {
      throw new Error("source path is not an allowed source file");
    }
    return { absolute: real, relative: relativePath };
  }

  function readText(path: ResolvedPath): string {
    if (!statSync(path.absolute).isFile()) throw new Error("source path is not a file");
    if (statSync(path.absolute).size > SOURCE_INSPECTOR_LIMITS.maxFileBytes) {
      throw new Error("source file exceeds the read limit");
    }
    return readFileSync(path.absolute, "utf8");
  }

  async function read(input: {
    path: string;
    startLine?: number;
    lineCount?: number;
  }): Promise<SourceExcerpt> {
    const path = resolvePath(input.path);
    const startLine = input.startLine ?? 1;
    if (!Number.isInteger(startLine) || startLine < 1)
      throw new Error("startLine must be positive");
    if (
      input.lineCount !== undefined &&
      (!Number.isInteger(input.lineCount) || input.lineCount < 1)
    ) {
      throw new Error("lineCount must be positive");
    }
    const lineCount = Math.min(
      SOURCE_INSPECTOR_LIMITS.maxExcerptLines,
      Math.max(1, Math.floor(input.lineCount ?? SOURCE_INSPECTOR_LIMITS.maxExcerptLines))
    );
    const excerpt = excerptFromLines(
      path.relative,
      splitLines(readText(path)),
      startLine,
      lineCount
    );
    const reason = rejectReason(excerpt.text);
    if (reason) throw new Error(`source excerpt rejected: ${reason}`);
    return excerpt;
  }

  async function search(input: {
    query: string;
    pathPrefix?: string;
    limit?: number;
  }): Promise<SourceSearchResult> {
    if (!input.query) throw new Error("search query must not be empty");
    const limit = Math.min(
      SOURCE_INSPECTOR_LIMITS.maxMatches,
      Math.max(0, Math.floor(input.limit ?? SOURCE_INSPECTOR_LIMITS.maxMatches))
    );
    const start = input.pathPrefix ? resolvePath(input.pathPrefix, true) : null;
    const rootPath = start?.absolute ?? rootReal;
    const visitedDirectories = new Set<string>();
    const matches: SourceExcerpt[] = [];
    const rejected: { path: string; reason: string }[] = [];
    let filesScanned = 0;
    let truncated = false;

    const addRejected = (path: string, reason: string): void => {
      const next = { path, reason };
      const candidate = { matches, filesScanned, truncated, rejected: [...rejected, next] };
      if (responseFits(candidate)) rejected.push(next);
    };

    const visit = (absolute: string): void => {
      if (matches.length >= limit || filesScanned >= SOURCE_INSPECTOR_LIMITS.maxFilesScanned) {
        truncated = filesScanned >= SOURCE_INSPECTOR_LIMITS.maxFilesScanned;
        return;
      }
      const real = realpathSync(absolute);
      if (!isContained(real, rootReal)) {
        addRejected(relative(root, absolute), "path resolves outside the workspace");
        return;
      }
      const relativePath = relative(root, absolute);
      if (relativePath && (!isAllowedRelative(relativePath) || isExcludedFile(relativePath)))
        return;
      const stat = statSync(real);
      if (stat.isDirectory()) {
        if (visitedDirectories.has(real)) return;
        visitedDirectories.add(real);
        for (const entry of readdirSync(real, { withFileTypes: true }))
          visit(resolve(real, entry.name));
        return;
      }
      if (!stat.isFile()) return;
      filesScanned += 1;
      if (stat.size > SOURCE_INSPECTOR_LIMITS.maxFileBytes) {
        addRejected(relativePath, "source file exceeds the read limit");
        return;
      }
      const text = readFileSync(real, "utf8");
      const lines = splitLines(text);
      const query = input.query.toLowerCase();
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        if (!lines[index]!.toLowerCase().includes(query)) continue;
        const excerpt = excerptFromLines(relativePath, lines, index + 1, 1);
        const reason = rejectReason(excerpt.text);
        if (reason) {
          addRejected(relativePath, reason);
          continue;
        }
        const candidate = { matches: [...matches, excerpt], filesScanned, truncated, rejected };
        if (!responseFits(candidate)) {
          truncated = true;
          return;
        }
        matches.push(excerpt);
      }
    };

    visit(rootPath);
    while (!responseFits({ matches, filesScanned, truncated, rejected })) {
      if (rejected.length > 0) rejected.pop();
      else if (matches.length > 0) matches.pop();
      else break;
    }
    return { matches, filesScanned, truncated, rejected };
  }

  return { read, search };
}
