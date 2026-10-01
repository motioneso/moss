// Per-provider updater state on the tools volume (#2689 slice 4, spec 6.1).
// `providers/<provider>/state.json` is written only by the runner. It is read back with a
// strict shape check, so a damaged or hand-edited file reads as "no state" instead of
// steering the updater.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StagedPackage {
  readonly role: "cli" | "chat-adapter";
  /** Install slot under `providers/` that holds the release. */
  readonly slot: string;
  readonly pkg: string;
  readonly version: string;
  /** Release folder name under `providers/<slot>/releases/`. */
  readonly release: string;
}

export interface ToolsState {
  readonly manifestSequence: number;
  readonly candidate: readonly StagedPackage[];
}

export const EMPTY_TOOLS_STATE: ToolsState = { manifestSequence: 0, candidate: [] };

const RELEASE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SLOT_RE = /^[a-z][a-z0-9-]{0,63}$/;

function isStaged(v: unknown): v is StagedPackage {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.role === "cli" || r.role === "chat-adapter") &&
    typeof r.slot === "string" &&
    SLOT_RE.test(r.slot) &&
    typeof r.pkg === "string" &&
    typeof r.version === "string" &&
    typeof r.release === "string" &&
    RELEASE_RE.test(r.release)
  );
}

export function stateFilePath(toolsPrefix: string, provider: string): string {
  return path.join(toolsPrefix, "providers", provider, "state.json");
}

export async function readToolsState(toolsPrefix: string, provider: string): Promise<ToolsState> {
  try {
    const raw: unknown = JSON.parse(await readFile(stateFilePath(toolsPrefix, provider), "utf8"));
    if (typeof raw !== "object" || raw === null) return EMPTY_TOOLS_STATE;
    const r = raw as Record<string, unknown>;
    const seq = r.manifestSequence;
    if (!Number.isInteger(seq) || (seq as number) < 0) return EMPTY_TOOLS_STATE;
    if (!Array.isArray(r.candidate) || !r.candidate.every(isStaged)) return EMPTY_TOOLS_STATE;
    return { manifestSequence: seq as number, candidate: r.candidate };
  } catch {
    return EMPTY_TOOLS_STATE;
  }
}

/** Atomic write: temp file in the same folder, then rename. */
export async function writeToolsState(
  toolsPrefix: string,
  provider: string,
  state: ToolsState
): Promise<void> {
  const file = stateFilePath(toolsPrefix, provider);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
