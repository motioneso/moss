import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalAppPath,
  HttpError,
  type RouteCatalog,
  type ToolContext,
  type ToolExecute,
  type ToolInput
} from "@moss/module-sdk";

/** Settings owns these structural capabilities; the composition host supplies them. */
export interface AppCatalogReadService {
  catalog(): RouteCatalog | null;
}

interface AppActionCallInput {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

export interface AppActionWriteService {
  call(input: AppActionCallInput, ctx: ToolContext): Promise<{ status: number; body: unknown }>;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".md"]);
const MAX_SOURCE_LINES = 400;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

class AppActionToolError extends HttpError {
  constructor(
    readonly code: "not_ready" | "invalid_input" | "source_path_not_allowed" | "source_unavailable",
    message: string
  ) {
    super(code === "not_ready" || code === "source_unavailable" ? 503 : 400, `${code}: ${message}`);
  }
}

export const appFindActionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 240 },
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }
} as const;

export const appFindActionOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["method", "path", "module", "access", "title", "inputShape", "coveredBy"],
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          module: { type: "string" },
          access: { type: "string", enum: ["read", "write", "destructive", "blocked"] },
          title: { type: ["string", "null"] },
          inputShape: {},
          coveredBy: { type: ["string", "null"] },
          category: { type: "string" }
        }
      }
    }
  }
} as const;

export const appCallActionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["method", "path"],
  properties: {
    method: { type: "string", enum: METHODS },
    path: { type: "string", minLength: 1, maxLength: 2048 },
    query: { type: "object", additionalProperties: { type: "string" } },
    body: {}
  }
} as const;

export const appCallActionOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "body"],
  properties: {
    status: { type: "integer" },
    ok: { type: "boolean" },
    // The route owns its response schema; the gateway applies its existing rendered result cap.
    body: {}
  }
} as const;

export const appReadSourceInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 2048 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  }
} as const;

export const appReadSourceOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "startLine", "endLine", "text"],
  properties: {
    path: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
    text: { type: "string" }
  }
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCatalogService(value: unknown): value is AppCatalogReadService {
  return isRecord(value) && typeof value.catalog === "function";
}

function isActionService(value: unknown): value is AppActionWriteService {
  return isRecord(value) && typeof value.call === "function";
}

function hasOnlyKeys(input: ToolInput, keys: readonly string[]): boolean {
  return isRecord(input) && Object.keys(input).every((key) => keys.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export const appFindActionExecute: ToolExecute = async (_db, input, _ctx, services) => {
  if (
    !hasOnlyKeys(input, ["query", "limit"]) ||
    typeof input.query !== "string" ||
    !input.query.trim() ||
    input.query.length > 240 ||
    (input.limit !== undefined && (!isPositiveInteger(input.limit) || input.limit > 20))
  ) {
    throw new AppActionToolError("invalid_input", "Supply a query and a limit from 1 to 20.");
  }
  const service = services?.appCatalog;
  if (!isCatalogService(service)) {
    throw new AppActionToolError("not_ready", "appCatalog service is unavailable");
  }
  const catalog = service.catalog();
  if (!catalog) throw new AppActionToolError("not_ready", "App actions are not ready yet.");
  return {
    data: {
      actions: catalog.search(input.query.trim(), input.limit ?? 8).map((route) => ({
        method: route.method,
        path: route.path,
        module: route.moduleId,
        access: route.policy.access,
        title: route.policy.title ?? null,
        inputShape: route.inputShape,
        coveredBy: route.policy.coveredBy ?? null,
        ...(route.policy.access === "blocked" ? { category: route.policy.blockedBecause } : {})
      }))
    }
  };
};

function isAppActionCallInput(input: ToolInput): input is ToolInput & AppActionCallInput {
  return (
    hasOnlyKeys(input, ["method", "path", "query", "body"]) &&
    METHODS.some((method) => method === input.method) &&
    typeof input.path === "string" &&
    input.path.length <= 2048 &&
    canonicalAppPath(input.path) !== null &&
    (input.query === undefined ||
      (isRecord(input.query) &&
        Object.values(input.query).every((value) => typeof value === "string")))
  );
}

export const appCallActionExecute: ToolExecute = async (_db, input, ctx, services) => {
  if (!isAppActionCallInput(input)) {
    throw new AppActionToolError(
      "invalid_input",
      "Supply a method, an app path and optional query or body."
    );
  }
  const service = services?.appActions;
  if (!isActionService(service)) {
    throw new AppActionToolError("not_ready", "appActions service is unavailable");
  }
  const response = await service.call(input, ctx);
  return { data: response.status >= 400 ? { ...response, ok: false } : response };
};

/** Walk up to the install marker, including when esbuild relocates this code to dist/. */
export function findAppInstallRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync("/app/pnpm-workspace.yaml")) return "/app";
  // A source reader must not treat an arbitrary launch directory as an installation.
  throw new AppActionToolError("source_unavailable", "The running app source is unavailable.");
}

function isAllowedSourcePath(path: string): boolean {
  if (isAbsolute(path) || path.includes("\\")) return false;
  const parts = path.split("/");
  return (
    (parts[0] === "packages" || parts[0] === "apps") &&
    parts.length >= 4 &&
    parts[2] === "src" &&
    parts.every(
      (part) =>
        part !== "" && part !== "." && part !== ".." && !part.toLowerCase().startsWith(".env")
    ) &&
    SOURCE_EXTENSIONS.has(extname(path))
  );
}

function refuseSourcePath(): never {
  throw new AppActionToolError(
    "source_path_not_allowed",
    "Only installed app source files are readable."
  );
}

/** The optional root is host-owned test injection, never a tool input or service capability. */
export function createAppReadSourceExecute(installRoot?: string): ToolExecute {
  return async (_db, input) => {
    const startLine = input.startLine ?? 1;
    const endLine = input.endLine;
    if (
      !hasOnlyKeys(input, ["path", "startLine", "endLine"]) ||
      typeof input.path !== "string" ||
      input.path.length > 2048 ||
      !isPositiveInteger(startLine) ||
      (endLine !== undefined && (!isPositiveInteger(endLine) || endLine < startLine))
    ) {
      throw new AppActionToolError(
        "invalid_input",
        "Supply a source path and positive, ordered line numbers."
      );
    }
    if (!isAllowedSourcePath(input.path)) refuseSourcePath();
    try {
      const root = await realpath(installRoot ?? findAppInstallRoot(MODULE_DIR));
      const sourceRoot = resolve(root, ...input.path.split("/").slice(0, 3));
      const path = await realpath(resolve(root, input.path));
      // Anchor to the declared physical root, not a symlink-resolved root outside the install.
      if (
        !path.startsWith(`${sourceRoot}${sep}`) ||
        !isAllowedSourcePath(relative(root, path).split(sep).join("/"))
      ) {
        refuseSourcePath();
      }
      if (!(await stat(path)).isFile()) refuseSourcePath();
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const selected = lines.slice(
        startLine - 1,
        Math.min(endLine ?? Infinity, startLine - 1 + MAX_SOURCE_LINES)
      );
      return {
        data: {
          path: relative(root, path).split(sep).join("/"),
          startLine,
          endLine: startLine - 1 + selected.length,
          text: selected.join("\n")
        }
      };
    } catch (error) {
      if (error instanceof AppActionToolError) throw error;
      // Filesystem errors contain absolute paths; expose only a fixed recovery message.
      throw new AppActionToolError(
        "source_unavailable",
        "The requested source file is unavailable."
      );
    }
  };
}

export const appReadSourceExecute = createAppReadSourceExecute();
