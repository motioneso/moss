import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { HttpError, type ToolExecute, type ToolResult, type ToolServices } from "@moss/module-sdk";
import { NOTES_SOURCE_PREFERENCE_KEY, resolveNotesRoots } from "@moss/settings";
import { PreferencesRepository } from "@moss/structured-state";

import { assertWithinRoot, recheckWithinRoot, NotesPathError } from "./path-guard.js";

export interface NotesSyncToolService {
  enqueue(actorUserId: string, sourcePath: string): Promise<string | null>;
}

const preferences = new PreferencesRepository();

function requireMarkdownPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\0") ||
    isAbsolute(input) ||
    !input.endsWith(".md") ||
    input.split(/[\\/]+/).includes("..")
  ) {
    throw new HttpError(400, "path must be a relative Markdown path");
  }
  return normalize(input);
}

/**
 * When the AI supplies an absolute sourcePath from notes.search, strip the notes root prefix
 * so the path passes requireMarkdownPath. Non-absolute inputs are returned unchanged.
 * Absolute paths that don't start with root are passed through as-is — requireMarkdownPath
 * will then reject them.
 */
function coerceToRelativePath(input: unknown, root: string): unknown {
  if (typeof input !== "string" || !isAbsolute(input)) return input;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return input.startsWith(prefix) ? input.slice(prefix.length) : input;
}

async function resolveAllowedRoots(): Promise<string[]> {
  const roots = resolveNotesRoots();
  if (roots.length === 0) throw new HttpError(503, "Notes roots not configured on this server");
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // Ignore stale configured roots; the linked source check below still fails closed.
    }
  }
  if (resolved.length === 0) throw new HttpError(503, "Notes roots not configured on this server");
  return resolved;
}

export async function resolveSource(scopedDb: DataContextDb): Promise<string> {
  const source = await preferences.get(scopedDb, NOTES_SOURCE_PREFERENCE_KEY);
  if (typeof source !== "string" || source.length === 0) {
    throw new HttpError(409, "Notes source is not configured");
  }

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(source);
  } catch {
    throw new HttpError(400, "Notes source path does not exist or cannot be resolved");
  }
  const allowedRoots = await resolveAllowedRoots();
  if (!allowedRoots.some((root) => contains(root, resolvedSource))) {
    throw new HttpError(400, "Notes source path is not within an allowed notes root");
  }
  return resolvedSource;
}

function contains(root: string, path: string): boolean {
  try {
    assertWithinRoot(root, path);
    return true;
  } catch {
    return false;
  }
}

export function assertInside(root: string, path: string): void {
  try {
    assertWithinRoot(root, path);
  } catch {
    throw new HttpError(400, "path is not within the linked notes source");
  }
}

export async function recheckInside(root: string, path: string): Promise<void> {
  try {
    await recheckWithinRoot(root, path);
  } catch (error) {
    if (error instanceof NotesPathError) {
      throw new HttpError(400, "path is not within the linked notes source");
    }
    throw error;
  }
}

async function resolveExistingFile(root: string, rel: string): Promise<string> {
  const absolutePath = join(root, rel);
  const stat = await lstat(absolutePath);
  if (!stat.isFile()) throw new HttpError(400, "path must reference a Markdown file");
  const resolvedFile = await realpath(absolutePath);
  assertInside(root, resolvedFile);
  return resolvedFile;
}

async function rejectSymlinkParent(root: string, rel: string): Promise<void> {
  const parent = dirname(rel);
  if (parent === ".") return;

  let current = root;
  for (const segment of parent.split(/[\\/]+/)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new HttpError(400, "path is not within the linked notes source");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

const pathLocks = new Map<string, Promise<void>>();

// ponytail: in-process FIFO mutex only — serializes concurrent edits to the same resolved file
// path within a single API process. Multiple API replicas would each hold their own independent
// lock map, so this stops being sufficient the moment the API scales beyond one process; replace
// with a cross-process file/advisory lock if that becomes the deployment shape.
async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const ourLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = pathLocks.get(key) ?? Promise.resolve();
  const ourTail = previous.then(() => ourLock);
  pathLocks.set(key, ourTail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === ourTail) {
      pathLocks.delete(key);
    }
  }
}

function getSyncService(services: ToolServices | undefined): NotesSyncToolService {
  const service = services?.["notesSync"] as NotesSyncToolService | undefined;
  if (!service || typeof service.enqueue !== "function") {
    throw new HttpError(500, "notesSync service is not configured");
  }
  return service;
}

async function sync(
  services: ToolServices | undefined,
  actorUserId: string,
  sourcePath: string,
  rel: string
): Promise<ToolResult> {
  await getSyncService(services).enqueue(actorUserId, sourcePath);
  return { data: { path: rel, synced: true } };
}

export const notesCreateExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const raw = input as { path?: unknown; content?: unknown; overwrite?: unknown };
  if (typeof raw.content !== "string") throw new HttpError(400, "content must be a string");

  const root = await resolveSource(scopedDb);
  const rel = requireMarkdownPath(coerceToRelativePath(raw.path, root));
  const file = join(root, rel);
  await rejectSymlinkParent(root, rel);
  await mkdir(dirname(file), { recursive: true });
  const resolvedParent = await realpath(dirname(file));
  assertInside(root, resolvedParent);

  if (raw.overwrite === true) {
    try {
      await resolveExistingFile(root, rel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await recheckInside(root, file);
    await writeFile(file, raw.content, "utf-8");
  } else {
    let handle: FileHandle;
    await recheckInside(root, file);
    try {
      handle = await open(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HttpError(409, "Note already exists");
      }
      throw error;
    }
    try {
      await handle.writeFile(raw.content, "utf-8");
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  return sync(services, ctx.actorUserId, root, rel);
};

export const notesEditExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const raw = input as { path?: unknown; oldText?: unknown; newText?: unknown };
  if (typeof raw.oldText !== "string" || typeof raw.newText !== "string") {
    throw new HttpError(400, "oldText and newText must be strings");
  }
  // An empty oldText makes `content.split(oldText).length - 1` length-dependent: it can equal
  // exactly 1 for some file lengths, slipping past the "appears once" guard below and causing
  // `content.replace("", newText)` to silently prepend newText. Reject it outright, independent
  // of file content/length.
  if (raw.oldText.length === 0) {
    throw new HttpError(400, "oldText must be non-empty");
  }

  const oldText = raw.oldText;
  const newText = raw.newText;
  const root = await resolveSource(scopedDb);
  const rel = requireMarkdownPath(coerceToRelativePath(raw.path, root));
  const file = await resolveExistingFile(root, rel);
  await withPathLock(file, async () => {
    await recheckInside(root, file);
    const content = await readFile(file, "utf-8");
    const count = content.split(oldText).length - 1;
    if (count !== 1) throw new HttpError(409, `oldText appears ${count} times`);
    await recheckInside(root, file);
    await writeFile(file, content.replace(oldText, newText), "utf-8");
  });
  return sync(services, ctx.actorUserId, root, rel);
};

export const notesDeleteExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const raw = input as { path?: unknown };

  const root = await resolveSource(scopedDb);
  const rel = requireMarkdownPath(coerceToRelativePath(raw.path, root));
  const file = await resolveExistingFile(root, rel);
  await recheckInside(root, file);
  await unlink(file);
  return sync(services, ctx.actorUserId, root, rel);
};
