/**
 * esbuild bundler for the production image's RESIDENT services (api, worker).
 * Produces a single runnable file per entrypoint under dist/, resolving the
 * @moss/* SOURCE-ONLY workspace graph at build time so the api/worker runtime
 * is plain `node dist/...` (no tsx, no per-start pnpm install — deployable-stack §1/§2).
 *
 * migrate is intentionally NOT a target here: it runs as `tsx scripts/migrate.ts`
 * because module SQL dirs are resolved via `import.meta.url` and bundling would
 * collapse every module's URL to the bundle's, breaking SQL resolution.
 *
 * Native deps that load .node binaries (onnxruntime-node, sharp, node-pty) and
 * the transformers wrapper are kept EXTERNAL — they must be required from the
 * pruned production node_modules at runtime, never inlined (Open Risk #3/#6).
 */
import { copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { build, type Plugin } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chatRequire = createRequire(resolve(root, "packages/chat/package.json"));

type Target = "api" | "worker";

const ENTRYPOINTS: Record<Target, { entry: string; outfile: string }> = {
  api: { entry: "apps/api/src/server.ts", outfile: "dist/server.js" },
  worker: { entry: "apps/worker/src/worker.ts", outfile: "dist/worker.js" }
};

// Packages that must NOT be bundled: they load native binaries or read files
// relative to their own package dir at runtime. Resolved from node_modules instead.
// #1059: node-pty MUST be external. The api/worker entrypoints reach the
// @moss/cli-runner barrel (module-registry onboarding imports PROVIDER_CATALOG/
// LOGIN_ADAPTERS), and the barrel re-exports `main` → TerminalHost → TerminalSession
// → `import "node-pty"`. node-pty is a native module: its loader resolves pty.node
// via prebuilds/ paths relative to its own dir, which esbuild COLLAPSES when inlined,
// so a bundled `node dist/server.js` throws at boot loading the binding. The prod
// image keeps the full node_modules (Dockerfile runtime = FROM build) with the
// compiled pty.node, so an external `require("node-pty")` resolves correctly — same
// treatment as onnxruntime-node/sharp. Without this the cli-runner sidecar boots
// (tsx source path, non-prod smoke) but the bundled api crashes, failing ONLY the
// prod compose smoke. [[bundled-path-resolution-trap]]
const EXTERNAL = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "sharp",
  "pg-native",
  "node-pty"
];

/**
 * better-auth's kysely-adapter ships bun/d1/node-sqlite dialect chunks that it
 * loads via gated `await import()` ONLY when a SQLite driver is configured. Jarv1s
 * is Postgres-only, so those code paths are never executed — but esbuild still
 * statically walks the dynamic imports and fails because the chunks import
 * `DEFAULT_MIGRATION_TABLE`/`DEFAULT_MIGRATION_LOCK_TABLE`, symbols that kysely
 * 0.29.2 no longer exports. Mark these dead dialect chunks (and the `node:sqlite`
 * builtin they reach for) external so the bundle keeps the un-taken `import()` as a
 * runtime require that is never reached under our Postgres driver. Without this the
 * api/worker bundles cannot be produced at all.
 */
const externalizeUnusedSqliteDialects: Plugin = {
  name: "externalize-unused-sqlite-dialects",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(bun|d1|node)-sqlite-dialect/ }, (args) => ({
      path: args.path,
      external: true
    }));
    pluginBuild.onResolve({ filter: /^node:sqlite$/ }, (args) => ({
      path: args.path,
      external: true
    }));
  }
};

async function buildTarget(target: Target): Promise<void> {
  const { entry, outfile } = ENTRYPOINTS[target];
  if (target === "api") {
    execFileSync("pnpm", ["build:app-map"], { cwd: root, stdio: "inherit" });
  }
  const buildBundle = async (source: string, output: string): Promise<void> => {
    await build({
      entryPoints: [resolve(root, source)],
      outfile: resolve(root, output),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      sourcemap: true,
      // Resolve @moss/* via the workspace symlinks in node_modules (preferred) or
      // fall back to the tsconfig path aliases; esbuild follows node resolution by
      // default through the symlinked workspace packages.
      external: EXTERNAL,
      plugins: [externalizeUnusedSqliteDialects],
      // ESM bundle needs these shims for CJS-style globals used by deps.
      banner: {
        js: [
          "import { createRequire as __jarvisCreateRequire } from 'node:module';",
          "import { fileURLToPath as __jarvisFileURLToPath } from 'node:url';",
          "import { dirname as __jarvisDirname } from 'node:path';",
          "const require = __jarvisCreateRequire(import.meta.url);",
          "const __filename = __jarvisFileURLToPath(import.meta.url);",
          "const __dirname = __jarvisDirname(__filename);"
        ].join("\n")
      },
      logLevel: "info"
    });
    execFileSync(process.execPath, ["--check", resolve(root, output)], { stdio: "inherit" });
  };

  await buildBundle(entry, outfile);
  if (target === "worker") {
    await buildBundle(
      "packages/memory/src/local-embedding-worker.ts",
      "dist/local-embedding-worker.js"
    );
  }
  if (target === "api") {
    const workerSource = resolve(
      dirname(chatRequire.resolve("pdf-parse/worker")),
      "../pdf.worker.mjs"
    );
    copyFileSync(workerSource, resolve(root, dirname(outfile), "pdf.worker.mjs"));
    copyFileSync(
      resolve(root, "packages/ai/src/gateway/pattern-worker.mjs"),
      resolve(root, dirname(outfile), "pattern-worker.mjs")
    );
  }
  console.log(`built ${outfile} (parse-checked)`);
}

async function main(): Promise<void> {
  const target = process.argv[2] as Target | undefined;
  if (target && target in ENTRYPOINTS) {
    await buildTarget(target);
    return;
  }
  // No/unknown arg -> build both resident entrypoints (api + worker).
  for (const t of Object.keys(ENTRYPOINTS) as Target[]) {
    await buildTarget(t);
  }
}

await main();
