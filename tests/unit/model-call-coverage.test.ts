import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Plan 3.6b (#2890), ruling 15: the activity log must record EVERY model call. Coverage is not
 * uniform — provider adapters record at their boundary (3.6a), several paths record per turn or
 * per job, and a few direct one-shot spawns record explicitly. This guard scans the source for
 * adapter constructions and model-binary spawns and fails when a new call site appears outside the
 * known, recorded seams, forcing a deliberate coverage decision instead of a silent gap.
 *
 * It is a source-shape guard, not a runtime proof: a passing test means every detected call site
 * is on the allow-list below. Adding a call site means adding the file here (and recording it) or
 * the guard fails with the offending `file:line`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Production files allowed to construct a provider adapter. Each records through the process-wide
 * activity recorder installed at both composition roots (`registerBuiltInApiRoutes` /
 * `registerBuiltInModuleWorkers`), OR defines the recording adapter itself.
 */
const ADAPTER_CONSTRUCTION_ALLOWLIST = new Set([
  // 3.6a: the recording adapter and its re-export.
  "packages/ai/src/adapters/http-api.ts",
  "packages/ai/src/chat-adapter.ts",
  // The three central functions: they build an adapter that records via the recorder.
  "packages/ai/src/generate-text.ts",
  "packages/ai/src/structured/generate-structured.ts",
  // Direct adapter callers whose calls record via the process-wide recorder.
  "packages/ai/src/transcription-routes.ts",
  "packages/chat/src/jobs.ts",
  "packages/commitments/src/workers.ts",
  "packages/workshop/src/project-reply.ts",
  "packages/tasks/src/search-interpret-route.ts",
  "packages/briefings/src/compose-shared.ts",
  "packages/module-registry/src/built-in-module-helpers.ts",
  // The CLI structured adapter: records internally, and its factory is wired by the composition root.
  "packages/chat/src/live/cli-structured-adapter.ts",
  "packages/module-registry/src/index.ts",
  // Composition roots that build the recording CLI structured adapter factory. The adapter records
  // through the process-wide recorder / its injected recorder, so no extra call-site work is due.
  "apps/api/src/focus-service.ts",
  "apps/api/src/server.ts",
  "apps/worker/src/external-module-ai-bridge.ts"
]);

/**
 * Production files allowed to spawn a model binary as a one-shot model call. Each records one row
 * for the call (probes and check turns, plan 3.6b).
 */
const MODEL_SPAWN_ALLOWLIST = new Set([
  "packages/chat/src/live/provider-probe.ts",
  "packages/module-registry/src/chat-multiplexer.ts"
]);

const ADAPTER_CONSTRUCTION_RE =
  /(?:new\s+HttpApiAdapter\s*\(|new\s+CliStructuredAdapter\s*\(|createCliStructuredAdapterFactory\s*\()/g;

/** A tuple spawn of a CLI model binary, e.g. `io.run("claude", ["--print", ...])`. */
const MODEL_SPAWN_RE = /\.run\(\s*"(claude|codex|gemini)"\s*,\s*\[([^\]]*)\]/g;

/** Args that mark a real model invocation rather than an auth/version/list subcommand. */
const MODEL_INVOCATION_FLAG_RE = /--print|--prompt|"exec"|\bexec\b/;

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

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findAdapterConstructions(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ["packages", "apps"]) {
    for (const file of walkSourceFiles(join(REPO_ROOT, root))) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((text, index) => {
        ADAPTER_CONSTRUCTION_RE.lastIndex = 0;
        if (ADAPTER_CONSTRUCTION_RE.test(text)) {
          hits.push({ file: relative(REPO_ROOT, file), line: index + 1, text: text.trim() });
        }
      });
    }
  }
  return hits;
}

function findModelSpawns(): Hit[] {
  const hits: Hit[] = [];
  for (const root of ["packages", "apps"]) {
    for (const file of walkSourceFiles(join(REPO_ROOT, root))) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((text, index) => {
        MODEL_SPAWN_RE.lastIndex = 0;
        const match = MODEL_SPAWN_RE.exec(text);
        if (!match) return;
        const args = match[2] ?? "";
        // Only model invocations count; auth/version/list subcommands make no model call.
        MODEL_INVOCATION_FLAG_RE.lastIndex = 0;
        if (!MODEL_INVOCATION_FLAG_RE.test(args)) return;
        hits.push({ file: relative(REPO_ROOT, file), line: index + 1, text: text.trim() });
      });
    }
  }
  return hits;
}

function describeHit(hit: Hit): string {
  return `${hit.file}:${hit.line} — ${hit.text}`;
}

describe("model call coverage guard (plan 3.6b, #2890)", () => {
  it("finds adapter constructions on the real tree (the scan is not silently empty)", () => {
    expect(findAdapterConstructions().length).toBeGreaterThan(0);
  });

  it("every provider-adapter construction is in a recorded seam", () => {
    const uncovered = findAdapterConstructions().filter(
      (hit) => !ADAPTER_CONSTRUCTION_ALLOWLIST.has(hit.file)
    );
    expect(
      uncovered,
      `New provider-adapter construction outside the recorded seams:\n${uncovered
        .map(describeHit)
        .join("\n")}\nIf this call records model activity, add its file to ` +
        "ADAPTER_CONSTRUCTION_ALLOWLIST and make it record (see packages/ai/src/model-activity.ts)."
    ).toEqual([]);
  });

  it("every model-binary one-shot spawn is in a recorded seam", () => {
    const uncovered = findModelSpawns().filter((hit) => !MODEL_SPAWN_ALLOWLIST.has(hit.file));
    expect(
      uncovered,
      `New model-binary spawn outside the recorded seams:\n${uncovered
        .map(describeHit)
        .join("\n")}\nRecord one model activity row for this call, then add its file to ` +
        "MODEL_SPAWN_ALLOWLIST."
    ).toEqual([]);
  });

  it("detects a deliberately uncovered adapter construction (the guard can fail)", () => {
    // Simulates a new call site: a file not on the allow-list constructing an adapter.
    const simulated: Hit = {
      file: "packages/example/src/new-call-site.ts",
      line: 1,
      text: "new HttpApiAdapter(kind, key, {})"
    };
    const uncovered = [simulated].filter((hit) => !ADAPTER_CONSTRUCTION_ALLOWLIST.has(hit.file));
    expect(uncovered.map(describeHit)).toEqual([
      "packages/example/src/new-call-site.ts:1 — new HttpApiAdapter(kind, key, {})"
    ]);
  });

  it("excludes auth/version subcommands from the model-spawn scan", () => {
    // `codex login status` / `codex --version` are not model calls and must not be flagged.
    MODEL_SPAWN_RE.lastIndex = 0;
    const login = MODEL_SPAWN_RE.exec('io.run("codex", ["login", "status"])');
    expect(login).not.toBeNull();
    MODEL_INVOCATION_FLAG_RE.lastIndex = 0;
    expect(MODEL_INVOCATION_FLAG_RE.test(login![2] ?? "")).toBe(false);
  });
});
