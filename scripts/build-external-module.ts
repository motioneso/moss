// scripts/build-external-module.ts
// JS-01 (#930): bundles an external module package's two artifacts. Kept at the
// repo root (not inside the package) because it needs the workspace's esbuild
// and the SDK source path; the core image never runs it (external-modules/ is
// dockerignored and this script is only wired to explicit build:external:*
// package scripts).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export async function buildExternalModule(moduleDir: string): Promise<void> {
  const dir = resolve(moduleDir);
  // Worker: self-contained CJS for `node dist/worker.js` in a scrubbed env with
  // no node_modules — the SDK is compiled in via the workspace source alias.
  await build({
    entryPoints: [join(dir, "src/worker/index.ts")],
    outfile: join(dir, "dist/worker.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: false,
    logLevel: "silent",
    // #1723 item 1: `/time` is aliased alongside `/worker` for the same reason — external-modules/*
    // sits outside the pnpm workspace, so there is no node_modules symlink to resolve through. It is
    // a subpath rather than the root barrel deliberately: the barrel carries the whole manifest type
    // surface plus the logger, and a module that wants two date functions should not pull that in.
    alias: {
      "@moss/module-sdk/worker": join(repoRoot, "packages/module-sdk/src/worker.ts"),
      "@moss/module-sdk/time": join(repoRoot, "packages/module-sdk/src/time.ts"),
      "@moss/module-sdk/list-limits": join(repoRoot, "packages/module-sdk/src/list-limits.ts")
    }
  });
  // Web: browser ESM; must stay react-free (JSX compiles to `h`/`Fragment`, either the
  // module's own src/web/runtime.ts, explicitly imported by hand-authored files, or — for
  // @moss/ui components bundled in via @moss/module-web-sdk, which never import h/Fragment
  // themselves — the `inject`ed reactRuntimeShim below. Both delegate to the host React on the
  // frozen runtime global — asserted by the bundle-hygiene test). A bare "react"/"react-dom"
  // import (e.g. lucide-react, a runtime dependency of @moss/ui's chip/select icons) is
  // aliased to the same shims rather than left to resolve real npm react (#1388 Foundation).
  // "@moss/module-web-sdk" is aliased to source too — external-modules/* sits outside the
  // pnpm workspace (no node_modules symlink), same reason the worker build below aliases
  // "@moss/module-sdk/worker" to source instead of relying on package resolution.
  // Optional: worker-only modules (finance FIN-01, #1146) have no web surface
  // yet — `web` is an optional manifest section, so the build must not demand
  // an entrypoint the manifest never declares.
  const webEntry = join(dir, "src/web/index.ts");
  if (!existsSync(webEntry)) return;
  const reactRuntimeShim = join(repoRoot, "packages/module-web-sdk/src/runtime.ts");
  const reactDomRuntimeShim = join(repoRoot, "packages/module-web-sdk/src/react-dom-runtime.ts");
  const moduleWebSdk = join(repoRoot, "packages/module-web-sdk/src/index.ts");
  await build({
    entryPoints: [webEntry],
    outfile: join(dir, "dist/web/index.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    sourcemap: false,
    logLevel: "silent",
    jsx: "transform",
    jsxFactory: "h",
    jsxFragment: "Fragment",
    // Forces classic transform for EVERY file esbuild bundles, including @moss/ui's own
    // *.tsx sources — without this, esbuild's per-file nearest-tsconfig.json auto-discovery
    // finds packages/ui/tsconfig.json's "jsx": "react-jsx" and emits automatic-runtime
    // `import ... from "react/jsx-runtime"` for those files regardless of the jsx/jsxFactory
    // options above, which then fails to resolve (only bare "react"/"react-dom" are aliased,
    // not the "react/jsx-runtime" subpath). Discovered building the task-11 proof fixture.
    tsconfigRaw: {
      compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" }
    },
    inject: [reactRuntimeShim],
    alias: {
      react: reactRuntimeShim,
      "react-dom": reactDomRuntimeShim,
      "@moss/module-web-sdk": moduleWebSdk,
      // Same alias as the worker build above — a web surface needs the user's day too, and the
      // helpers are Intl-only precisely so the browser half can share them.
      "@moss/module-sdk/time": join(repoRoot, "packages/module-sdk/src/time.ts"),
      "@moss/module-sdk/list-limits": join(repoRoot, "packages/module-sdk/src/list-limits.ts")
    },
    // Task 18 (#1302): job-search's web surface injects its layout CSS via one <style> tag
    // (finance keeps the same string in a .ts constant instead); the `text` loader turns a
    // `.css` import into its raw-text default export at bundle time. No-op for finance, which
    // has no `.css` import.
    loader: { ".css": "text" }
  });
}

// CLI: `tsx scripts/build-external-module.ts external-modules/finance`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: tsx scripts/build-external-module.ts <module-dir>");
    process.exit(1);
  }
  buildExternalModule(target).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
