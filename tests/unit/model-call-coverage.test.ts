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
 * It also runs three broader checks, per QA rounds 2 to 4:
 *  - EVERY file that imports the Node child-process library (`node:child_process` or
 *    `child_process`, by `import ... from`, `import()`, `require()` or `import x = require()`) must
 *    be in the process-start allow-list or the model-spawn allow-list, with a reason. Anchoring on
 *    the import covers every call form (`spawn`, `execFile`, promisified wrappers, `cp.spawn`,
 *    renamed imports, `fork`), including a model program started from a variable command, which
 *    the quote-anchored check above cannot see.
 *  - EVERY file that names a shared command-runner helper (`createRealTmuxIo`,
 *    `createSanitizedTmuxIo`, `createOwnerIo`, `runBounded`, `perUserSessionIo`,
 *    `createModuleBuildIo`, `AcpExecManager`, `preparePerUserStructuredLaunch`,
 *    `runConstrainedStructuredProcess`) must be in the
 *    runner allow-list, with a reason. The
 *    names match as bare identifiers, so a call, an import, a renamed import, a dynamic-import
 *    destructure and a variable that stores the helper all match. A rename through a value
 *    re-export (`export { A as B } from ...`) is tracked across the scan, so a file using `B`
 *    is flagged. The finder skips a helper's own definition (`function X`, `class X`),
 *    comment lines and `export { ... } from` re-export lines. These helpers hand out a
 *    run-any-command function, so a file can start a program through them without importing
 *    the child-process library.
 *  - EVERY chat-engine construction (`new AcpChatEngine(`, `new CliChatEngineImpl(`,
 *    `new CodexExecSession(`, `createStructuredEngine(`, the persistent runtimes, and the CLI
 *    structured adapter factory) must appear in the chat-engine allow-list, so a new engine built
 *    outside the recorded places fails.
 *
 * Source files scanned are `.ts`, `.tsx`, `.mjs`, `.cjs` and `.js` under `packages` and `apps`.
 *
 * Known limitations, stated so nobody trusts it further than it goes:
 *  - The allow-lists are per FILE. A second, unlogged model call added INSIDE an allow-listed file
 *    passes silently. Adding a call site means adding its file here (and recording it) or the guard
 *    fails with the offending `file:line`. This applies to every check.
 *  - A model endpoint reached through a configurable base URL (not a literal host in source) is not
 *    detectable statically; the adapter allow-list covers those callers instead.
 *  - The process checks cannot tell a model program from a plain utility process (tmux, rm,
 *    setpriv, an external module child). They flag both; a file that merely runs utilities is
 *    allow-listed with a reason, and a reviewer weighing that reason is the safety net.
 *  - The process-start check is anchored on import syntax. These routes to the library are NOT
 *    caught: `createRequire(...)` followed by a require, and `process.getBuiltinModule(...)`.
 *  - The runner check matches only the names above. A new runner helper is not caught until
 *    its name is added to the pattern.
 *  - A runner passed in as a parameter or a dependency (for example a `createSlotIo` dependency)
 *    is not caught in the file that receives it. Only the file that names the helper is checked.
 *  - A runner reached through a string-built or computed property name is not caught.
 *  - Only renames through `export { ... } from` are tracked. A locally-defined alias
 *    re-exported without a `from` clause and consumed elsewhere still escapes.
 *  - A name used only inside a string, a template literal or a block comment line that does not
 *    start with `*` still matches, so those can raise a false alarm. Such a file needs an entry.
 *  - The chat-engine check matches the known constructors by name; a brand-new engine class whose
 *    constructor is not listed here is not caught until this list grows. Keeping the list here
 *    beside the recorder seam is the deliberate cost.
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
  // Meeting ASR uses HttpApiAdapter.transcribeAudio, which records the owner-bound
  // transcribe.meeting action through the installed process-wide recorder.
  "packages/ai/src/configured-transcription.ts",
  "packages/chat/src/jobs.ts",
  "packages/commitments/src/workers.ts",
  "packages/workshop/src/project-reply.ts",
  "packages/tasks/src/search-interpret-route.ts",
  "packages/briefings/src/compose-shared.ts",
  "packages/module-registry/src/built-in-module-helpers.ts",
  "packages/chat/src/live/cli-structured-adapter.ts",
  "packages/chat/src/live/constrained-structured-adapter.ts",
  "packages/module-registry/src/index.ts",
  // Chat composition root: builds the classifier gate's structured adapter factory. The classifier
  // calls go through generateStructured, so the adapter records them.
  "packages/chat/src/routes.ts",
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
  // Constrained executable selection and child launch are recorded once by the API-side
  // constrained structured adapter. The cli-runner has no DB recorder; do not record again.
  "packages/chat/src/live/constrained-structured-engine.ts",
  "packages/chat/src/live/constrained-structured-process.ts",
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

/**
 * Files allowed to import the Node child-process library. A model-program file is ALSO in
 * MODEL_SPAWN_ALLOWLIST above; the entries here are the others, each with the reason it is safe.
 * A new file that imports the library must be added here (or above) with a reason, or the guard
 * fails with its `file:line`.
 */
const PROCESS_START_ALLOWLIST = new Map<string, string>([
  [
    "apps/api/src/herdr-install-port.ts",
    "runs the fixed install-herdr.sh script; no request supplies a command and no model is called"
  ],
  [
    "packages/ai/src/adapters/tmux-bridge.ts",
    "shared tmux runner that hosts the persistent Claude and Codex chat sessions; it launches the model CLI but each turn is recorded by the chat session manager's answer line, not here"
  ],
  [
    "packages/ai/src/cli-availability.ts",
    "runs `command -v <binary>` to see whether a CLI is installed; no model turn runs"
  ],
  [
    "packages/cli-runner/src/acp-execs.ts",
    "runs a module-build shell command (sh -c), not a model program"
  ],
  [
    "packages/cli-runner/src/acp-host.ts",
    "spawns the ACP model adapter and the process-kill stoppers; the adapter's turns are recorded by the chat session manager's answer line"
  ],
  [
    "packages/cli-runner/src/acp-transcript-purge.ts",
    "runs filesystem purge commands, not a model program"
  ],
  [
    "packages/cli-runner/src/agent-home-prepare-run.ts",
    "runs agent-home prepare commands, not a model program"
  ],
  [
    "packages/cli-runner/src/owned-fs.ts",
    "runs owner-scoped filesystem commands, not a model program"
  ],
  [
    "packages/cli-runner/src/per-user-structured.ts",
    "bounded runner behind the owner-run tmux and file I/O helper (createOwnerIo); it moves files and drives tmux, and starts no model turn itself"
  ],
  [
    "packages/cli-runner/src/runner-io.ts",
    "sanitized-env tmux and file I/O for the engine host; hosts the persistent chat sessions whose turns the chat session manager records"
  ],
  [
    "packages/module-registry/src/external/worker-runtime.ts",
    "spawns an external module's own child process, not a model program"
  ]
]);

/**
 * Files allowed to call a shared command-runner factory or build the shell-command manager. Each
 * entry says why the program that can start through it is safe. A new calling file fails until it
 * is added here with a reason.
 */
const RUNNER_CALL_ALLOWLIST = new Map<string, string>([
  [
    "packages/chat/src/live/constrained-structured-engine.ts",
    "calls the bounded child helper for constrained structured turns; the API-side constrained adapter records exactly one owner-bound activity entry"
  ],
  [
    "apps/worker/src/worker.ts",
    "builds the sanitized runner for module-build CLI turns, which the module-build engine records"
  ],
  [
    "packages/chat/src/live/runtime.ts",
    "chat composition root; the engines built over this runner answer through the chat session manager's answer line"
  ],
  [
    "packages/cli-runner/src/acp-host.ts",
    "builds owner-run login reads and the shell-command manager for module builds; the ACP model adapter's turns are recorded by the chat session manager's answer line"
  ],
  [
    "packages/cli-runner/src/main.ts",
    "cli-runner entrypoint; builds the runner for the persistent and structured engines, whose turns the callers record"
  ],
  [
    "packages/cli-runner/src/per-user-slot.ts",
    "builds the per-user runner for the persistent runtime, whose turns the chat session manager records"
  ],
  [
    "packages/cli-runner/src/per-user-structured.ts",
    "builds owner-run runners for login reads and agent-home file I/O; no model turn starts here"
  ],
  [
    "packages/cli-runner/src/engine-host.ts",
    "picks the per-user runner for each persistent or structured launch; the launched chat turns are recorded by the chat session manager's answer line"
  ],
  [
    "packages/module-registry/src/chat-multiplexer.ts",
    "builds the runner for CLI probes, provider checks and persistent engines; probes and checks are recorded, engine turns go through the chat session manager's answer line"
  ]
]);

/**
 * Files allowed to build a chat engine. Every one is a recorded composition seam: the engine it
 * builds is recorded by the chat session manager's answer line or is itself the recording
 * adapter. A new engine built anywhere else fails until its file is added here with a reason.
 */
const CHAT_ENGINE_ALLOWLIST = new Map<string, string>([
  [
    "packages/chat/src/live/constrained-structured-adapter.ts",
    "defines the constrained structured adapter factory and records each settled call"
  ],
  [
    "apps/api/src/focus-service.ts",
    "builds the structured adapter factory for the server; recorded"
  ],
  ["apps/api/src/server.ts", "builds the structured adapter factory for the server; recorded"],
  [
    "apps/worker/src/external-module-ai-bridge.ts",
    "builds the structured adapter factory for the worker; recorded"
  ],
  [
    "packages/chat/src/live/acp-chat-engine.ts",
    "defines the ACP engine and its factory; its turns are recorded by the chat session manager's answer line"
  ],
  [
    "packages/chat/src/live/cli-check-turn.ts",
    "builds an ACP engine for a recorded CLI check turn (kind: check)"
  ],
  [
    "packages/chat/src/live/cli-structured-adapter.ts",
    "defines the recording CLI structured adapter"
  ],
  [
    "packages/chat/src/live/module-build-cli-engine.ts",
    "builds the Codex one-shot session for a recorded module-build turn"
  ],
  [
    "packages/chat/src/live/persistent-runtime-engine.ts",
    "builds the persistent runtime engines; their turns are recorded by the chat session manager's answer line"
  ],
  [
    "packages/chat/src/live/runtime.ts",
    "the chat composition root: builds the engine factory whose turns the chat session manager records"
  ],
  [
    "packages/chat/src/live/structured-engine-selection.ts",
    "selects and constructs the structured engine; callers record it"
  ],
  [
    "packages/cli-runner/src/engine-host.ts",
    "cli-runner engine host; builds the structured engine whose calls the adapter records"
  ],
  [
    "packages/cli-runner/src/main.ts",
    "cli-runner entrypoint: builds the persistent runtime whose turns are recorded"
  ],
  [
    "packages/module-registry/src/index.ts",
    "composition root: builds the structured adapter factories whose calls are recorded"
  ],
  [
    "packages/chat/src/routes.ts",
    "chat composition root: builds the classifier gate's structured adapter factory; its calls are recorded by the adapter"
  ]
]);

const ADAPTER_CONSTRUCTION_RE =
  /(?:new\s+HttpApiAdapter\s*\(|new\s+CliStructuredAdapter\s*\(|(?:createCliStructuredAdapterFactory|createConstrainedCliStructuredAdapterFactory)\s*\()/g;

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
    if (!/\.(?:tsx?|mjs|cjs|js)$/.test(entry.name)) continue;
    if (/\.test\.(?:tsx?|mjs|cjs|js)$/.test(entry.name)) continue;
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

/**
 * Any import of the Node child-process library: static import/export-from, dynamic `import()`,
 * `require()` and `import x = require()`. A mention in a comment or string without that syntax does
 * not match. This is the anchor for every way of starting a process.
 */
const CHILD_PROCESS_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`](?:node:)?child_process["'`]/g;

/**
 * Any mention of a shared command-runner helper by name, with no call bracket required, so a
 * renamed import, a dynamic-import destructure or a variable that stores the helper still matches.
 * The lookbehinds skip the helper's own definition. The finder also skips comment lines and
 * `export { ... } from` re-export lines.
 */
const RUNNER_NAMES = [
  "createRealTmuxIo",
  "createSanitizedTmuxIo",
  "createOwnerIo",
  "runBounded",
  "perUserSessionIo",
  "createModuleBuildIo",
  "AcpExecManager",
  "preparePerUserStructuredLaunch",
  "runConstrainedStructuredProcess"
] as const;

const RUNNER_NAME_RE = new RegExp(
  `(?<!function\\s)(?<!class\\s)\\b(?:${RUNNER_NAMES.join("|")})\\b`,
  "g"
);

/** A value re-export that renames a runner (`export { runBounded as rb } from ...`). */
const REEXPORT_RENAME_RE = /export\s*\{([^}]*)\}\s*from\s*["'`]/g;

/** Aliases handed out by renamed value re-exports, mapped back to the runner name. */
function runnerReexportAliases(files: readonly SourceFile[]): Map<string, string> {
  const known = new Set<string>(RUNNER_NAMES);
  const aliases = new Map<string, string>();
  for (const { text } of files) {
    for (const match of text.matchAll(REEXPORT_RENAME_RE)) {
      for (const part of (match[1] ?? "").split(",")) {
        const pair = part.split(/\s+as\s+/).map((entry) => entry.trim());
        if (pair.length !== 2) continue;
        const [original, alias] = pair as [string, string];
        if (known.has(original) && alias && !known.has(alias) && !aliases.has(alias)) {
          aliases.set(alias, original);
        }
      }
    }
  }
  return aliases;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Known chat-engine constructors. A new one outside the allow-list fails the guard. */
const CHAT_ENGINE_RE =
  /(?:new\s+(?:AcpChatEngine|CliChatEngineImpl|CodexExecSession|ClaudePersistentRuntime|CodexPersistentRuntime|ModuleBuildCliEngine|ConstrainedStructuredEngine)|createStructuredEngine|createRpcAcpEngine|createCliStructuredAdapterFactory|createConstrainedCliStructuredAdapterFactory)\s*\(/g;

function findProcessStarts(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(CHILD_PROCESS_IMPORT_RE)) {
      hits.push({
        file,
        line: lineOf(text, match.index ?? 0),
        detail: "imports the child-process library"
      });
    }
  }
  return dedupeByFileAndLine(hits);
}

function runnerLineSkipped(text: string, index: number, line: string): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  if (/^\s*(?:\/\/|\*|\/\*)/.test(text.slice(lineStart, index))) return true;
  return /^\s*export\s*(?:type\s*)?\{[^}]*\}\s*from\b/.test(line);
}

function findRunnerCalls(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  const aliases = runnerReexportAliases(files);
  const aliasRe =
    aliases.size === 0
      ? null
      : new RegExp(
          `(?<!function\\s)(?<!class\\s)\\b(?:${[...aliases.keys()].map(escapeRegExp).join("|")})\\b`,
          "g"
        );
  for (const { file, text } of files) {
    for (const match of text.matchAll(RUNNER_NAME_RE)) {
      const index = match.index ?? 0;
      const lineStart = text.lastIndexOf("\n", index) + 1;
      const lineEnd = text.indexOf("\n", index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (runnerLineSkipped(text, index, line)) continue;
      hits.push({ file, line: lineOf(text, index), detail: `runner use ${match[0]}` });
    }
    if (aliasRe) {
      for (const match of text.matchAll(aliasRe)) {
        const index = match.index ?? 0;
        const lineStart = text.lastIndexOf("\n", index) + 1;
        const lineEnd = text.indexOf("\n", index);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (runnerLineSkipped(text, index, line)) continue;
        hits.push({
          file,
          line: lineOf(text, index),
          detail: `runner use ${match[0]} (re-export of ${aliases.get(match[0])})`
        });
      }
    }
  }
  return dedupeByFileAndLine(hits);
}

function findChatEngineConstructions(files: readonly SourceFile[]): Hit[] {
  const hits: Hit[] = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(CHAT_ENGINE_RE)) {
      hits.push({
        file,
        line: lineOf(text, match.index ?? 0),
        detail: `chat engine ${match[0].trim()}`
      });
    }
  }
  return dedupeByFileAndLine(hits);
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

function uncovered(
  hits: readonly Hit[],
  allow: ReadonlySet<string> | ReadonlyMap<string, string>
): Hit[] {
  return hits.filter((hit) => !allow.has(hit.file));
}

/**
 * A file that reaches the recorder itself must keep doing so. These are the files where recording
 * is explicit (a probe, a chat answer line, an embedding sink, the adapter boundary, the fill-in
 * choices fetch). Removing the call from one of them must fail the guard, which is exactly the
 * "new unlogged call" the plan wants caught.
 */
const RECORDER_REF_RE =
  /(?:recordModelActivity|withModelActivityRecording|installModelActivityRecorder|installEmbeddingActivityRecorder|withEmbeddingActivity|onModelCall|createDbModelActivityRecorder)/;

const EXPLICIT_RECORDING_FILES = [
  "packages/ai/src/adapters/http-api.ts",
  "packages/ai/src/structured/generate-choices.ts",
  "packages/ai/src/model-activity.ts",
  "packages/chat/src/live/cli-structured-adapter.ts",
  "packages/chat/src/live/constrained-structured-adapter.ts",
  "packages/chat/src/live/provider-probe.ts",
  "packages/chat/src/live/cli-check-turn.ts",
  "packages/chat/src/live/chat-session-turn.ts",
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
    expect(findProcessStarts(files).length).toBeGreaterThan(0);
    expect(findChatEngineConstructions(files).length).toBeGreaterThan(0);
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

  it("every child-process import is in a recorded or explicitly allowed file", () => {
    // A model-program file is allow-listed on either list; a utility file only on
    // PROCESS_START_ALLOWLIST. So the covered set is the union of both.
    const covered = new Set<string>([...MODEL_SPAWN_ALLOWLIST, ...PROCESS_START_ALLOWLIST.keys()]);
    const off = uncovered(findProcessStarts(files), covered);
    expect(
      off,
      `New process start outside the recorded/allowed files:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every chat-engine construction is in an allowed composition file", () => {
    const off = uncovered(findChatEngineConstructions(files), CHAT_ENGINE_ALLOWLIST);
    expect(
      off,
      `New chat-engine construction outside the recorded places:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every shared command-runner call is in an allowed file", () => {
    const off = uncovered(findRunnerCalls(files), RUNNER_CALL_ALLOWLIST);
    expect(
      off,
      `New runner call outside the allowed files:\n${off.map(describeHit).join("\n")}`
    ).toEqual([]);
  });

  it("every runner-call allow-list entry still calls a runner", () => {
    const calling = new Set(findRunnerCalls(files).map((hit) => hit.file));
    const stale = [...RUNNER_CALL_ALLOWLIST.keys()].filter((file) => !calling.has(file));
    expect(stale, `Stale runner-call entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it.each([
    [
      "the tmux runner with a variable command",
      `import { createRealTmuxIo } from "./adapters/tmux-bridge.js";\nexport const go = (bin: string, p: string) => createRealTmuxIo().run(bin, ["--print", p]);`
    ],
    ["the constrained child helper", `await runConstrainedStructuredProcess(options);`],
    [
      "a renamed constrained child import",
      `import { runConstrainedStructuredProcess as run } from "./constrained-structured-process.js"; run(options);`
    ],
    ["the sanitized runner", `const io = createSanitizedTmuxIo(env);\nawait io.run(bin, []);`],
    ["the owner runner", `const io = createOwnerIo(identity);`],
    ["the shell-command manager", `const m = new AcpExecManager(deps);`],
    [
      "the bounded runner",
      `import { runBounded } from "./per-user-structured.js";\nexport const go = (bin: string, p: string) => runBounded(bin, ["--print", p], process.env, "");`
    ],
    ["the per-user session runner", `const io = slot.perUserSessionIo(deps, key, params);`],
    ["the module-build runner", `const io = createModuleBuildIo(deps);`],
    [
      "the launch-prep helper",
      `const l = await preparePerUserStructuredLaunch(deps, key, params);\nawait l.io.run(bin, ["--print", p]);`
    ],
    [
      "a renamed import",
      `import { runBounded as go } from "./per-user-structured.js";\ngo(bin, []);`
    ],
    [
      "a dynamic-import destructure",
      `const { createOwnerIo: make } = await import("./runner-io.js");`
    ],
    ["a runner stored in a variable", `const make = createSanitizedTmuxIo;\nmake(env);`]
  ])("flags %s in an unlisted file", (_name, body) => {
    const file = "packages/example/runner.ts";
    const hits = findRunnerCalls([{ file, text: body }]);
    expect(hits.length).toBeGreaterThan(0);
    expect([...new Set(uncovered(hits, RUNNER_CALL_ALLOWLIST).map((hit) => hit.file))]).toEqual([
      file
    ]);
  });

  it("flags a consumer using a renamed runner re-export", () => {
    const files = [
      {
        file: "packages/example/runner-barrel.ts",
        text: `export { runBounded as rb } from "./per-user-structured.js";`
      },
      {
        file: "packages/example/renamed-use.ts",
        text: `import { rb } from "./runner-barrel.js";\nrb(bin, []);`
      }
    ];
    const hits = findRunnerCalls(files);
    expect(uncovered(hits, RUNNER_CALL_ALLOWLIST).map(describeHit)).toEqual([
      "packages/example/renamed-use.ts:1 — runner use rb (re-export of runBounded)",
      "packages/example/renamed-use.ts:2 — runner use rb (re-export of runBounded)"
    ]);
  });

  it("flags a renamed constrained child re-export consumer", () => {
    const hits = findRunnerCalls([
      {
        file: "packages/example/barrel.ts",
        text: 'export { runConstrainedStructuredProcess as execute } from "./process.js";'
      },
      { file: "packages/example/use.ts", text: "execute(options);" }
    ]);
    expect(uncovered(hits, RUNNER_CALL_ALLOWLIST).map((hit) => hit.file)).toEqual([
      "packages/example/use.ts"
    ]);
  });

  it.each([
    "new ConstrainedStructuredEngine(provider, io, home, identity)",
    "createConstrainedCliStructuredAdapterFactory(factory)"
  ])("flags a new constrained construction: %s", (text) => {
    const file = "packages/example/constrained.ts";
    expect(
      uncovered(findChatEngineConstructions([{ file, text }]), CHAT_ENGINE_ALLOWLIST)
    ).toHaveLength(1);
    if (text.startsWith("create")) {
      expect(
        uncovered(findAdapterConstructions([{ file, text }]), ADAPTER_CONSTRUCTION_ALLOWLIST)
      ).toHaveLength(1);
    }
  });

  it("requires the constrained adapter recording boundary", () => {
    const file = "packages/chat/src/live/constrained-structured-adapter.ts";
    expect(
      missingRecorderRefs(files.map((entry) => (entry.file === file ? { file, text: "" } : entry)))
    ).toContain(file);
  });

  it("scans .mjs, .cjs and .js files, not only TypeScript", () => {
    const scanned = new Set(files.map((entry) => entry.file));
    expect(scanned.has("packages/ai/src/gateway/pattern-worker.mjs")).toBe(true);
  });

  it("does not flag a runner definition, a comment mentioning it or a re-export", () => {
    const text = [
      "export function createRealTmuxIo(baseEnv = process.env) {",
      "  // createSanitizedTmuxIo() sources the env before this runs",
      "  * createOwnerIo() is documented here",
      'export { createSanitizedTmuxIo } from "./runner-io.js";',
      "}"
    ].join("\n");
    expect(findRunnerCalls([{ file: "packages/example/def.ts", text }])).toEqual([]);
  });

  const COVERED_FOR_PROCESS_STARTS = new Set<string>([
    ...MODEL_SPAWN_ALLOWLIST,
    ...PROCESS_START_ALLOWLIST.keys()
  ]);

  it.each([
    ["a variable-command spawn", `import { spawn } from "node:child_process";\nspawn(cmd, args);`],
    ["a plain execFile", `import { execFile } from "node:child_process";\nexecFile(cmd, args);`],
    [
      "a promisified execFile",
      `import { execFile } from "child_process";\nconst run = promisify(execFile);`
    ],
    ["a namespace import", `import * as cp from "node:child_process";\ncp.spawn(cmd, args);`],
    ["a renamed import", `import { spawn as start } from "node:child_process";\nstart(cmd, args);`],
    ["fork", `import { fork } from "node:child_process";\nfork(modulePath);`],
    ["a require call", `const { spawn } = require("node:child_process");`],
    ["a dynamic import", `const cp = await import("node:child_process");`],
    ["an import-equals require", `import cp = require("child_process");`]
  ])("flags %s in an unlisted file", (_name, body) => {
    const file = "packages/example/unlisted.ts";
    const hits = findProcessStarts([{ file, text: body }]);
    expect(hits.length).toBe(1);
    expect(uncovered(hits, COVERED_FOR_PROCESS_STARTS).map((hit) => hit.file)).toEqual([file]);
  });

  it("does not flag a comment that only mentions the child-process library", () => {
    const text = [
      "// rather than in worker-runtime.ts (which needs `node:child_process`)",
      "const m = /^172\\.(\\d+)/.exec(hostname);",
      "await this.tunnel.spawn(sessionKey, projectId, kind, userId, profile);"
    ].join("\n");
    expect(findProcessStarts([{ file: "packages/example/benign.ts", text }])).toEqual([]);
  });

  it("every process-start allow-list entry still imports the child-process library", () => {
    const importing = new Set(findProcessStarts(files).map((hit) => hit.file));
    const stale = [...PROCESS_START_ALLOWLIST.keys()].filter((file) => !importing.has(file));
    expect(stale, `Stale allow-list entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it("catches a new chat engine built outside the recorded places", () => {
    const source = "const engine = new AcpChatEngine(provider, key, opts);";
    const hits = findChatEngineConstructions([
      { file: "packages/example/new-engine.ts", text: source }
    ]);
    expect(hits.map(describeHit)).toEqual([
      "packages/example/new-engine.ts:1 — chat engine new AcpChatEngine("
    ]);
    expect(uncovered(hits, CHAT_ENGINE_ALLOWLIST).map(describeHit)).toEqual([
      "packages/example/new-engine.ts:1 — chat engine new AcpChatEngine("
    ]);
  });
});
