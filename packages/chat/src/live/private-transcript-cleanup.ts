import { homedir } from "node:os";
import { join } from "node:path";

import { transcriptGlobDir, type TmuxIo } from "@moss/ai";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// #2028 — the Gemini CLI accepts the session id we generate (`--session-id <uuid>`), so the
// identity never has to be scraped back out of a log the way the old Antigravity path did.
const GEMINI_SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Codex v0.141.0 surrounds the /status UUID with ANSI SGR resets; #1076 keeps parsing the raw pane because composer evidence also needs its ANSI bytes.
const CODEX_STATUS_SESSION_PATTERN =
  // eslint-disable-next-line no-control-regex -- terminal panes contain ANSI SGR escapes by design.
  /\bSession:\s+(?:\x1b\[[0-9;]*m)*([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\x1b\[[0-9;]*m)*(?=\s|$|│)/gi;

/** Where the launch line redirects the Gemini CLI's `stream-json` output for this session. */
export const GEMINI_OUTPUT_FILENAME = ".jarvis-gemini-output.jsonl";
/** Where the launch line redirects the Gemini CLI's diagnostics for this session. */
export const GEMINI_STDERR_FILENAME = ".jarvis-gemini-stderr.log";
export const GEMINI_IDENTITY_FILENAME = ".jarvis-gemini-session-id";
export const CODEX_IDENTITY_FILENAME = ".jarvis-codex-session-id";

export function geminiHomeRoot(homeBase: string = homedir()): string {
  return join(homeBase, ".gemini");
}

export async function persistGeminiSessionIdentity(
  io: Pick<TmuxIo, "writeFile" | "run">,
  neutralDir: string,
  uuid: string
): Promise<void> {
  if (!UUID_PATTERN.test(uuid)) throw new Error("invalid Gemini session identity");
  await persistIdentity(
    io,
    neutralDir,
    GEMINI_IDENTITY_FILENAME,
    uuid.toLowerCase(),
    "Gemini session"
  );
}

export async function readGeminiSessionIdentity(
  io: Pick<TmuxIo, "readFile">,
  neutralDir: string
): Promise<string | null> {
  try {
    const uuid = (await io.readFile(join(neutralDir, GEMINI_IDENTITY_FILENAME))).trim();
    return UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * #2028 — the Gemini CLI names its per-folder state directories by a SHORT id of its own, not by
 * the session UUID, and that id cannot be computed: it is a slug of the folder name plus a `-1`
 * style suffix when two folders collide. `~/.gemini/projects.json` is the only place the mapping
 * exists, so a purge has to read it. Shape: `{ "projects": { "<absolute dir>": "<short id>" } }`.
 */
export function parseGeminiProjectShortId(registryJson: string, neutralDir: string): string | null {
  const registry = parseGeminiRegistry(registryJson);
  if (registry === null) return null;
  const shortId = registry.projects[neutralDir];
  if (typeof shortId !== "string" || !GEMINI_SHORT_ID_PATTERN.test(shortId)) return null;
  return shortId;
}

/**
 * Delete everything a headless Gemini turn leaves outside the session folder, plus the two private
 * files it leaves inside it. Fail-closed: any step that cannot be proven done returns `false` so
 * the identity marker survives for a later sweep (#1086's rule, kept).
 *
 * Measured on `@google/gemini-cli@0.57.0`: a `--print` run DOES persist state — `~/.gemini/tmp/<short id>`
 * (its saved chat), `~/.gemini/history/<short id>`, an entry in `~/.gemini/projects.json`, and stray
 * `projects.json.<uuid>.tmp` files left behind by its own registry writes. Crash reports written by the
 * CLI quote the prompt verbatim and land in the temporary directory, which the launch line points at
 * the session folder so they are swept here too.
 */
export async function purgeGeminiConversation(
  io: Pick<TmuxIo, "run" | "readFile" | "writeFile">,
  neutralDir: string,
  homeBase?: string
): Promise<boolean> {
  const swept = await io.run("find", [
    neutralDir,
    "-maxdepth",
    "1",
    "-name",
    "gemini-*.json",
    "-delete"
  ]);
  if (swept.code !== 0) return false;
  const removedOutput = await io.run("rm", [
    "-f",
    join(neutralDir, GEMINI_OUTPUT_FILENAME),
    join(neutralDir, GEMINI_STDERR_FILENAME)
  ]);
  if (removedOutput.code !== 0) return false;

  const root = geminiHomeRoot(homeBase);
  const registryPath = join(root, "projects.json");
  let registryJson: string;
  try {
    registryJson = await io.readFile(registryPath);
  } catch {
    // No registry at all means the CLI never recorded this folder, so it left nothing outside it.
    return true;
  }
  const registry = parseGeminiRegistry(registryJson);
  if (registry === null) return false;
  const recorded = registry.projects[neutralDir];
  if (recorded === undefined) return true;
  if (typeof recorded !== "string" || !GEMINI_SHORT_ID_PATTERN.test(recorded)) return false;

  // State directories first, registry entry last: a crash in between leaves the pointer intact.
  for (const bucket of ["tmp", "history"]) {
    const removed = await io.run("rm", ["-rf", join(root, bucket, recorded)]);
    if (removed.code !== 0) return false;
  }
  delete registry.projects[neutralDir];
  await io.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const sweptTemps = await io.run("find", [
    root,
    "-maxdepth",
    "1",
    "-name",
    "projects.json.*.tmp",
    "-delete"
  ]);
  return sweptTemps.code === 0;
}

export function parseCodexSessionUuid(pane: string): string | null {
  const ids = new Set<string>();
  for (const match of pane.matchAll(CODEX_STATUS_SESSION_PATTERN)) {
    if (match[1]) ids.add(match[1].toLowerCase());
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

export async function persistCodexSessionIdentity(
  io: Pick<TmuxIo, "writeFile" | "run">,
  neutralDir: string,
  uuid: string
): Promise<void> {
  if (!CODEX_UUID_PATTERN.test(uuid)) throw new Error("invalid Codex session identity");
  await persistIdentity(
    io,
    neutralDir,
    CODEX_IDENTITY_FILENAME,
    uuid.toLowerCase(),
    "Codex session"
  );
}

export async function readCodexSessionIdentity(
  io: Pick<TmuxIo, "readFile">,
  neutralDir: string
): Promise<string | null> {
  try {
    const uuid = (await io.readFile(join(neutralDir, CODEX_IDENTITY_FILENAME))).trim();
    return CODEX_UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function codexTranscriptPath(uuid: string, homeBase: string = homedir()): string {
  if (!CODEX_UUID_PATTERN.test(uuid)) throw new Error("invalid Codex session identity");
  const timestamp = Number(BigInt(`0x${uuid.replaceAll("-", "").slice(0, 12)}`));
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) throw new Error("invalid Codex session identity");
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return join(
    codexSessionsRoot(homeBase),
    year,
    month,
    day,
    `rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${uuid.toLowerCase()}.jsonl`
  );
}

export function codexTranscriptMatchesIdentity(
  jsonl: string,
  expectedUuid: string,
  expectedCwd: string
): boolean {
  for (const line of jsonl.split("\n").slice(0, 50)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record["type"] !== "session_meta") continue;
    const payload = record["payload"];
    if (!isRecord(payload)) continue;
    return payload["id"] === expectedUuid && payload["cwd"] === expectedCwd;
  }
  return false;
}

export async function purgeCodexTranscript(
  io: Pick<TmuxIo, "run" | "readFile">,
  neutralDir: string,
  capturedUuid: string | null | undefined,
  homeBase?: string
): Promise<boolean> {
  if (!capturedUuid || !CODEX_UUID_PATTERN.test(capturedUuid)) return false;
  const uuid = capturedUuid.toLowerCase();
  // #1086 — UUIDv7 time-derived paths drift with local-time reconstruction. Find the real
  // rollout by its UUID, then trust only the session_meta identity before deleting anything.
  const found = await io.run("find", [
    codexSessionsRoot(homeBase),
    "-type",
    "f",
    "-name",
    `*-${uuid}.jsonl`
  ]);
  if (found.code !== 0) return false;
  for (const path of found.stdout.split("\n").filter(Boolean)) {
    const jsonl = await io.readFile(path);
    if (!codexTranscriptMatchesIdentity(jsonl, uuid, neutralDir)) continue;
    const removed = await io.run("rm", ["-f", path]);
    return removed.code === 0;
  }
  // #1086 — not-found is not proof of absence: retain the marker/row for a later sweep.
  return false;
}

export async function purgePrivateTranscripts(
  io: Pick<TmuxIo, "run" | "readFile" | "writeFile">,
  neutralBase: string,
  sessionKey: string,
  homeBase?: string
): Promise<void> {
  const neutralDir = deriveNeutralDir(neutralBase, sessionKey);
  await removeChecked(io, ["-rf", transcriptGlobDir("anthropic", neutralDir, homeBase)]);
  await removeChecked(io, ["-f", join(neutralDir, "codex-exec-transcript.jsonl")]);

  const codexUuid = await readCodexSessionIdentity(io, neutralDir);
  if (codexUuid !== null) {
    if (!(await purgeCodexTranscript(io, neutralDir, codexUuid, homeBase)))
      throw new Error("Codex transcript identity mismatch");
    await removeChecked(io, ["-f", join(neutralDir, CODEX_IDENTITY_FILENAME)]);
  }

  // #1086/#2028 — the marker is written at launch, before the first turn, so a crash mid-turn
  // still leaves a pointer for the boot sweep to purge by.
  const geminiUuid = await readGeminiSessionIdentity(io, neutralDir);
  if (geminiUuid !== null) {
    if (!(await purgeGeminiConversation(io, neutralDir, homeBase))) {
      throw new Error("Could not purge Gemini conversation transcript");
    }
    await removeChecked(io, ["-f", join(neutralDir, GEMINI_IDENTITY_FILENAME)]);
  }
}

export async function purgePrivateTranscriptMarkers(
  io: Pick<TmuxIo, "run" | "readFile" | "writeFile">,
  neutralBase: string,
  homeBase?: string
): Promise<boolean> {
  const listed = await io.run("ls", ["-A", neutralBase]).catch(() => ({
    code: 1,
    stdout: ""
  }));
  if (listed.code !== 0) return true;
  let purged = true;
  for (const sessionKey of listed.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      sanitizeSessionKey(sessionKey);
    } catch {
      continue;
    }
    try {
      await purgePrivateTranscripts(io, neutralBase, sessionKey, homeBase);
    } catch {
      purged = false;
    }
  }
  return purged;
}

function codexSessionsRoot(homeBase: string = homedir()): string {
  return join(homeBase, ".codex", "sessions");
}

function deriveNeutralDir(neutralBase: string, sessionKey: string): string {
  return join(neutralBase, sanitizeSessionKey(sessionKey));
}

function sanitizeSessionKey(sessionKey: string): string {
  if (
    sessionKey.length === 0 ||
    sessionKey.includes("/") ||
    sessionKey.includes("\\") ||
    sessionKey.includes("\0") ||
    sessionKey === "." ||
    sessionKey === ".." ||
    sessionKey.includes("..")
  ) {
    throw new Error("invalid sessionKey");
  }
  return sessionKey;
}

async function persistIdentity(
  io: Pick<TmuxIo, "writeFile" | "run">,
  neutralDir: string,
  filename: string,
  uuid: string,
  label: string
): Promise<void> {
  const marker = join(neutralDir, filename);
  const temp = `${marker}.tmp`;
  await io.writeFile(temp, `${uuid}\n`);
  const chmod = await io.run("chmod", ["600", temp]);
  if (chmod.code !== 0) {
    await io.run("rm", ["-f", temp]);
    throw new Error(`Could not lock down ${label} identity marker`);
  }
  const moved = await io.run("mv", ["-f", temp, marker]);
  if (moved.code !== 0) {
    await io.run("rm", ["-f", temp]);
    throw new Error(`Could not persist ${label} identity marker`);
  }
}

async function removeChecked(io: Pick<TmuxIo, "run">, args: readonly string[]): Promise<void> {
  const result = await io.run("rm", args);
  if (result.code !== 0) throw new Error("Could not purge private transcript");
}

function parseGeminiRegistry(
  registryJson: string
): (Record<string, unknown> & { projects: Record<string, unknown> }) | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(registryJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const projects = parsed["projects"];
  if (!isRecord(projects)) return null;
  return { ...parsed, projects };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
