import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Plan 3.6b (#2890), ruling 15: the activity log must record EVERY model call. This guard scans the
 * source for the ways a model program is started and fails when a call site appears outside the
 * known, recorded seams, forcing a deliberate coverage decision instead of a silent gap.
 *
 * It scans each file's WHOLE text, so a call prettier wrapped across several lines still matches.
 * It catches, per QA on PR 2904:
 *  - provider-adapter constructions (`new HttpApiAdapter`, `new CliStructuredAdapter`, factories);
 *  - model-binary spawns regardless of wrapper: `io.run("claude"|"codex"|"gemini", ...)`,
 *    `spawn(...)`, and `bash -lc "... codex exec ..."` shell strings;
 *  - raw web calls to a model endpoint (the System One shape): `fetch`/`fetchImpl` against a known
 *    model host or path.
 *
 * Known limitations, stated so nobody trusts it further than it goes:
 *  - The allow-lists are per FILE. A second, unlogged model call added INSIDE an allow-listed file
 *    passes silently. Adding a call site means adding its file here (and recording it) or the guard
 *    fails with the offending `file:line`.
 *  - A model endpoint reached through a configurable base URL (not a literal host in source) is not
 *    detectable statically; the adapter allow-list covers those callers instead.
 *  - Test files and `__tests__` are excluded: they do not ship.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Files allowed to construct a provider adapter. Each records through the process-wide activity
 * recorder installed at both composition roots, OR defines the recording adapter itself.
 */
const ADAPTER_CONSTRUCTION_ALLOWLIST = new Set([
  "packages/ai/src/adapters/http-api.ts",
  "packages/ai/src/chat-adapter.ts",
  "packages/ai/src/generate-text.ts",
  "packages/ai/src/structured/generate-structured.ts",
  "packages/ai/src/transcription-routes.ts",
  "packages/chat/src/jobs.ts",
  "packages/commitments/src/workers.ts",
  "packages/workshop/src/project-reply.ts",
  "packages/tasks/src/search-interpret-route.ts",
  "packages/briefings/src/compose-shared.ts",
  "packages/module-registry/src/built-in-module-helpers.ts",
  "packages/chat/src/live/cli-structured-adapter.ts",
  "packages/module-registry/src/index.ts",
  "apps/api/src/focus-service.ts",
  "apps/api/src/server.ts",
  "apps/worker/src/external-module-ai-bridge.ts"
]);

/** Files allowed to start a model program. Each records one row for the call it makes. */
const MODEL_SPAWN_ALLOWLIST = new Set([
  // Probe one-shots ("claude --print", "gemini --prompt") and Codex login-status: recorded.
  "packages/chat/src/live/provider-probe.ts",
  "packages/module-registry/src/chat-multiplexer.ts",
  // The Codex one-shot session is the normal Codex engine in one-shot mode; its callers (live
  // chat's turn wrapper, the CLI structured adapter, and check turns) record it. It must not log.
  "packages/chat/src/live/module-build-codex-exec-session.ts",
  // CLI structured engine command builders (the calls are recorded by the adapter around them).
  "packages/chat/src/live/structured-claude-engine.ts",
  "packages/chat/src/live/structured-gemini-engine.ts",
  "packages/chat/src/live/module-build-launch-commands.ts",
  "packages/chat/src/live/claude-persistent-runtime.ts",
  "packages/chat/src/live/codex-persistent-runtime.ts",
  // One-shot engine builders that wrap recorded adapters or the chat turn wrapper.
  "packages/chat/src/live/cli-check-turn.ts",
  "packages/chat/src/live/acp-chat-engine.ts",
  "packages/chat/src/live/cli-engine-helpers.ts",
  // CLI management commands (login, version, model list): no model call is made.
  "packages/cli-runner/src/login-adapters.ts",
  "packages/cli-runner/src/model-list-adapters.ts",
  // Engine selection and the cli-runner host: they build/launch the engine whose calls are
  // recorded by the adapter (structured) or the chat turn wrapper (chat), never a bare call here.
  "packages/chat/src/live/structured-engine-selection.ts",
  "packages/cli-runner/src/engine-host.ts"
]);

/** Files allowed to `fetch` a model endpoint directly (outside the adapters). */
const MODEL_FETCH_ALLOWLIST = new Set([
  // The System One choices call: recorded explicitly in this file (plan 3.6b).
  "packages/ai/src/structured/generate-choices.ts",
  // The recording adapter itself performs the HTTP call it records.
  "packages/ai/src/adapters/http-api.ts",
  "packages/ai/src/adapters/http-api-structured.ts",
  // Structured/model transport builders that compose request URLs (no raw call here).
  "packages/ai/src/auto-register.ts"
]);

const ADAPTER_CONSTRUCTION_RE =
  /(?:new\s+HttpApiAdapter\s*\(|new\s+CliStructuredAdapter\s*\(|createCliStructuredAdapterFactory\s*\()/g;

/** A model-binary spawn, however wrapped: `.run(...)`, `spawn(...)`, `exec(...)`. */
const MODEL_BINARY_RE = /["'`](claude|codex|gemini)["'`]/g;
const SPAWN_CALL_RE = /\b(?:spawn|spawnSync|exec|execSync|run)\s*\(/;

/** A shell string that starts a model program, e.g. `bash -lc "... codex exec ..."`. */
const SHELL_MODEL_COMMAND_RE = /(?:codex\s+exec|claude\s+--print|gemini\s+--prompt|claude\s+-p\b)/g;

/** A raw web call to a model endpoint. Hosts/paths: System One, OpenAI, Anthropic, Google. */
const MODEL_FETCH_HOST_RE =
  /(api\.typesafe\.ai|\/v1\/systemone|\/v1\/chat\/completions|\/v1\/responses|api\.anthropic\.com|\/v1\/messages|generativelanguage\.googleapis\.com)/;

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") {
        continue;
      }
      out.push(...walkSourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const root of ["packages", "apps"]) {
    for (const full of walkSourceFiles(join(REPO_ROOT, root))) {
      files.push({ file: relative(REPO_ROOT, full), text: readFileSync(full, "utf8") });
    }
  }
  return files;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

function findAdapterConstructions(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(ADAPTER_CONSTRUCTION_RE)) {
      hits.push({ file, line: lineOf(text, match.index ?? 0), detail: "adapter construction" });
    }
  }
  return hits;
}

/**
 * A model-binary spawn: the binary name appears near a spawn-style call. Detected on the whole
 * file so multi-line calls match; the binary literal may be on a different line than the call.
 */
function findModelSpawns(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    const hasSpawn = SPAWN_CALL_RE.test(text);
    for (const match of text.matchAll(MODEL_BINARY_RE)) {
      const index = match.index ?? 0;
      // The binary must be used as a program start: a spawn-style call appears in the file and the
      // binary sits near it.
      const near = text.slice(Math.max(0, index - 200), index + 200);
      if (hasSpawn && (near.includes("run(") || near.includes("spawn") || near.includes("exec"))) {
        hits.push({ file, line: lineOf(text, index), detail: `model binary ${match[1]}` });
      }
    }
    // A shell command string that starts a model program, whatever binary literal quotes it
    // (e.g. `"codex exec --json"` built for `bash -lc`).
    for (const match of text.matchAll(SHELL_MODEL_COMMAND_RE)) {
      hits.push({
        file,
        line: lineOf(text, match.index ?? 0),
        detail: `shell model start: ${match[0].trim()}`
      });
    }
  }
  return dedupeByFileAndLine(hits);
}

function findModelFetches(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    const host = text.match(MODEL_FETCH_HOST_RE);
    if (!host) continue;
    if (!/\bfetch(?:Impl)?\s*\(/.test(text)) continue;
    hits.push({ file, line: lineOf(text, host.index ?? 0), detail: `model endpoint ${host[1]}` });
  }
  return hits;
}

function dedupeByFileAndLine(hits: readonly Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const hit of hits) {
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function describeHit(hit: Hit): string {
  return `${hit.file}:${hit.line} — ${hit.detail}`;
}

function uncovered(hits: readonly Hit[], allow: ReadonlySet<string>): Hit[] {
  return hits.filter((hit) => !allow.has(hit.file));
}

/**
 * A file that reaches the recorder itself must keep doing so. These are the files where recording
 * is explicit (a probe, a turn wrapper, an embedding sink, the adapter boundary, the fill-in
 * choices fetch). Removing the call from one of them must fail the guard, which is exactly the
 * "new unlogged call" the plan wants caught.
 */
const RECORDER_REF_RE =
  /(?:recordModelActivity|withModelActivityRecording|installModelActivityRecorder|installEmbeddingActivityRecorder|withEmbeddingActivity|withTurnActivityRecording|onModelCall|createDbModelActivityRecorder)/;

const EXPLICIT_RECORDING_FILES = [
  "packages/ai/src/adapters/http-api.ts",
  "packages/ai/src/structured/generate-choices.ts",
  "packages/ai/src/model-activity.ts",
  "packages/chat/src/live/cli-structured-adapter.ts",
  "packages/chat/src/live/provider-probe.ts",
  "packages/chat/src/live/cli-check-turn.ts",
  "packages/chat/src/live/turn-activity-engine.ts",
  "packages/chat/src/live/runtime.ts",
  "packages/memory/src/embedding-provider-config.ts",
  "packages/module-registry/src/chat-multiplexer.ts",
  "packages/module-registry/src/index.ts",
  "apps/worker/src/module-build-live-agent.ts",
  "apps/worker/src/worker.ts"
] as const;

function missingRecorderRefs(files: readonly SourceFile[]): string[] {
  const byFile = new Map(files.map((entry) => [entry.file, entry.text]));
  return EXPLICIT_RECORDING_FILES.filter((file) => {
    const text = byFile.get(file);
    return text === undefined || !RECORDER_REF_RE.test(text);
  });
}

describe("model call coverage guard (plan 3.6b, #2890)", () => {
  const files = sourceFiles();

  it("the scan is not silently empty (finds the known seams)", () => {
    expect(findAdapterConstructions(files).length).toBeGreaterThan(0);
    expect(findModelSpawns(files).length).toBeGreaterThan(0);
    expect(findModelFetches(files).length).toBeGreaterThan(0);
  });

  it("every provider-adapter construction is in a recorded seam", () => {
    const off = uncovered(findAdapterConstructions(files), ADAPTER_CONSTRUCTION_ALLOWLIST);
    expect(
      off,
      `New adapter construction outside the recorded seams:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every model-program start is in a recorded seam", () => {
    const off = uncovered(findModelSpawns(files), MODEL_SPAWN_ALLOWLIST);
    expect(
      off,
      `New model-program start outside the recorded seams:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every raw model-endpoint fetch is in a recorded seam", () => {
    const off = uncovered(findModelFetches(files), MODEL_FETCH_ALLOWLIST);
    expect(
      off,
      `New raw model-endpoint fetch outside the recorded seams:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every file that records explicitly still calls the recorder", () => {
    const missing = missingRecorderRefs(files);
    expect(
      missing,
      `These files are expected to record model activity but no recorder call was found:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("catches a wrapped multi-line spawn and the codex exec shell string", () => {
    const wrapped = [
      "packages/example/new.ts",
      "await io.run(",
      '  "codex",',
      '  ["exec", "--json"]',
      ");"
    ].join("\n");
    const hits = findModelSpawns([{ file: "packages/example/new.ts", text: wrapped }]);
    expect(hits.map(describeHit)).toContain("packages/example/new.ts:3 — model binary codex");

    const shell =
      'const cmd = "bash"; await io.run(cmd, ["-lc", " . /tok && codex exec --json < p "]);';
    const shellHits = findModelSpawns([{ file: "packages/example/shell.ts", text: shell }]);
    expect(shellHits.length).toBeGreaterThan(0);
  });

  it("catches a new raw fetch to a model endpoint", () => {
    const source = 'const r = await fetch(`${base}/v1/systemone`, { method: "POST" });';
    const hits = findModelFetches([{ file: "packages/example/fetch.ts", text: source }]);
    expect(hits.map(describeHit)).toEqual([
      "packages/example/fetch.ts:1 — model endpoint /v1/systemone"
    ]);
  });

  it("reports a real new file as uncovered (the guard can fail)", () => {
    const simulated = findAdapterConstructions([
      {
        file: "packages/example/new.ts",
        text: "const a = new HttpApiAdapter(kind, key, {});"
      }
    ]);
    const off = uncovered(simulated, ADAPTER_CONSTRUCTION_ALLOWLIST);
    expect(off.map(describeHit)).toEqual(["packages/example/new.ts:1 — adapter construction"]);
  });
});
