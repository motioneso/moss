import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    alias: [
      // The root test suite can render @moss/web React components (e.g. the onboarding
      // multiplexer step). react / react-dom / react-query are workspace deps of
      // @moss/web only, so resolve them from the web package's installed copies rather
      // than duplicating them as root devDependencies.
      {
        find: "react-dom",
        replacement: fileURLToPath(new URL("./apps/web/node_modules/react-dom", import.meta.url))
      },
      {
        find: "react",
        replacement: fileURLToPath(new URL("./apps/web/node_modules/react", import.meta.url))
      },
      {
        find: "@tanstack/react-query",
        replacement: fileURLToPath(
          new URL("./apps/web/node_modules/@tanstack/react-query", import.meta.url)
        )
      },
      {
        // react-router is a @moss/web-only dep; resolve it from the web package's copy so the
        // root suite can render web components that use <Link> / <MemoryRouter> (#369 empty-chat).
        find: "react-router",
        replacement: fileURLToPath(new URL("./apps/web/node_modules/react-router", import.meta.url))
      },
      {
        // Subpath export (#1274); must precede the bare "@moss/ai" alias below — used by
        // module-registry's validate.ts (compilePattern), same pairing requirement as the other
        // subpath/bare alias pairs in this file (host-fetch/policy, module-registry/node, ...).
        find: "@moss/ai/gateway/input-validation",
        replacement: fileURLToPath(
          new URL("./packages/ai/src/gateway/input-validation.ts", import.meta.url)
        )
      },
      {
        find: "@moss/ai",
        replacement: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/auth",
        replacement: fileURLToPath(new URL("./packages/auth/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/briefings",
        replacement: fileURLToPath(new URL("./packages/briefings/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/calendar",
        replacement: fileURLToPath(new URL("./packages/calendar/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/chat/priority-consumer",
        replacement: fileURLToPath(
          new URL("./packages/chat/src/priority-consumer.ts", import.meta.url)
        )
      },
      {
        // Subpath export (#802); must precede the bare "@moss/chat" alias below.
        find: "@moss/chat/live",
        replacement: fileURLToPath(new URL("./packages/chat/src/live/public.ts", import.meta.url))
      },
      {
        find: "@moss/chat",
        replacement: fileURLToPath(new URL("./packages/chat/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/db/probes",
        replacement: fileURLToPath(new URL("./packages/db/src/probes/index.ts", import.meta.url))
      },
      {
        find: "@moss/commitments/tools",
        replacement: fileURLToPath(new URL("./packages/commitments/src/tools.ts", import.meta.url))
      },
      {
        find: "@moss/commitments/routes",
        replacement: fileURLToPath(new URL("./packages/commitments/src/routes.ts", import.meta.url))
      },
      {
        find: "@moss/commitments/workers",
        replacement: fileURLToPath(
          new URL("./packages/commitments/src/workers.ts", import.meta.url)
        )
      },
      {
        find: "@moss/commitments/jobs",
        replacement: fileURLToPath(new URL("./packages/commitments/src/jobs.ts", import.meta.url))
      },
      {
        find: "@moss/commitments/extractor",
        replacement: fileURLToPath(
          new URL("./packages/commitments/src/extractor.ts", import.meta.url)
        )
      },
      {
        find: "@moss/commitments/prefilter",
        replacement: fileURLToPath(
          new URL("./packages/commitments/src/prefilter.ts", import.meta.url)
        )
      },
      {
        find: "@moss/commitments/signature",
        replacement: fileURLToPath(
          new URL("./packages/commitments/src/signature.ts", import.meta.url)
        )
      },
      {
        find: "@moss/commitments",
        replacement: fileURLToPath(new URL("./packages/commitments/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/connectors/presets",
        replacement: fileURLToPath(
          new URL("./packages/connectors/src/imap-presets.ts", import.meta.url)
        )
      },
      {
        find: "@moss/connectors",
        replacement: fileURLToPath(new URL("./packages/connectors/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/datasets",
        replacement: fileURLToPath(new URL("./packages/datasets/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/db",
        replacement: fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/email",
        replacement: fileURLToPath(new URL("./packages/email/src/index.ts", import.meta.url))
      },
      {
        // Subpath export; must precede the bare "@moss/host-fetch" alias below — used by
        // module-registry's validate.ts (assertValidFetchHosts).
        find: "@moss/host-fetch/policy",
        replacement: fileURLToPath(new URL("./packages/host-fetch/src/policy.ts", import.meta.url))
      },
      {
        // #1309: job-search's worker-rpc-host.ts fetch.request test coverage imports
        // HostPinningViolationError directly; host-fetch had no alias entry at all before this
        // (it was only reached transitively via module-registry's own workspace dependency).
        find: "@moss/host-fetch",
        replacement: fileURLToPath(new URL("./packages/host-fetch/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/integrations",
        replacement: fileURLToPath(new URL("./packages/integrations/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/jobs",
        replacement: fileURLToPath(new URL("./packages/jobs/src/index.ts", import.meta.url))
      },
      {
        // Server-only subpath export (#917); must precede the bare "@moss/module-registry"
        // alias below. The root vitest suite resolves @moss/* via this alias map rather than
        // the package.json "exports" map, so subpaths need an explicit entry — matching the
        // established @moss/module-sdk/core-version, @moss/chat/live, @moss/db/probes pattern.
        find: "@moss/module-registry/node",
        replacement: fileURLToPath(
          new URL("./packages/module-registry/src/node.ts", import.meta.url)
        )
      },
      {
        find: "@moss/module-registry",
        replacement: fileURLToPath(
          new URL("./packages/module-registry/src/index.ts", import.meta.url)
        )
      },
      {
        // Subpath export; must precede the bare "@moss/module-sdk" alias.
        find: "@moss/module-sdk/core-version",
        replacement: fileURLToPath(
          new URL("./packages/module-sdk/src/core-version.ts", import.meta.url)
        )
      },
      {
        // Subpath export (#1110 fix in 34457186); must precede the bare "@moss/module-sdk"
        // alias below, same pairing requirement as core-version above.
        find: "@moss/module-sdk/ai-capabilities",
        replacement: fileURLToPath(
          new URL("./packages/module-sdk/src/ai-capabilities.ts", import.meta.url)
        )
      },
      {
        // Subpath export (#1110 VF regression fix); must precede the bare "@moss/module-sdk"
        // alias below, same pairing requirement as core-version/ai-capabilities above.
        find: "@moss/module-sdk/errors",
        replacement: fileURLToPath(new URL("./packages/module-sdk/src/errors.ts", import.meta.url))
      },
      {
        // Subpath export (#1120: sessionRateLimitKey/mcpSessionRateLimitKey moved off the
        // barrel because they import node:crypto); must precede the bare "@moss/module-sdk"
        // alias below, same pairing requirement as core-version/ai-capabilities/errors above.
        find: "@moss/module-sdk/server",
        replacement: fileURLToPath(new URL("./packages/module-sdk/src/server.ts", import.meta.url))
      },
      {
        // Subpath export (#1723 item 1: local-day helpers, imported as values by Food's domain and
        // web code); must precede the bare "@moss/module-sdk" alias below, same pairing requirement
        // as core-version/ai-capabilities/errors/server above.
        find: "@moss/module-sdk/time",
        replacement: fileURLToPath(new URL("./packages/module-sdk/src/time.ts", import.meta.url))
      },
      {
        // Subpath export (#1723 item 3: the shape a module's list tool returns); must precede the
        // bare "@moss/module-sdk" alias below, same pairing requirement as the subpaths above.
        find: "@moss/module-sdk/list-limits",
        replacement: fileURLToPath(
          new URL("./packages/module-sdk/src/list-limits.ts", import.meta.url)
        )
      },
      {
        find: "@moss/module-sdk",
        replacement: fileURLToPath(new URL("./packages/module-sdk/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/module-web-sdk",
        replacement: fileURLToPath(
          new URL("./packages/module-web-sdk/src/index.ts", import.meta.url)
        )
      },
      {
        // `apps/web/src/app-route-metadata.ts` imports the Vite-generated
        // `virtual:moss-module-web` module (#799); this file has many transitive consumers
        // (page-context, command-palette-model, section-tour-model, today-page, ...), so alias it
        // globally to a test fixture instead of mocking it per-test-file.
        find: "virtual:moss-module-web",
        replacement: fileURLToPath(
          new URL("./tests/fixtures/virtual-moss-module-web.ts", import.meta.url)
        )
      },
      {
        find: "virtual:moss-module-settings",
        replacement: fileURLToPath(
          new URL("./tests/fixtures/virtual-moss-module-settings.ts", import.meta.url)
        )
      },
      {
        find: "@moss/notes",
        replacement: fileURLToPath(new URL("./packages/notes/src/index.ts", import.meta.url))
      },
      {
        // Subpath export; must precede the bare "@moss/news" alias.
        find: "@moss/news/web",
        replacement: fileURLToPath(new URL("./packages/news/src/web/index.tsx", import.meta.url))
      },
      {
        // #1025: root-level tests/uat/seed/chunks/news.ts needs NewsPrefsRepository; this
        // alias was missing entirely (every other module package has one).
        find: "@moss/news",
        replacement: fileURLToPath(new URL("./packages/news/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/proactive-monitoring",
        replacement: fileURLToPath(
          new URL("./packages/proactive-monitoring/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@moss/notifications",
        replacement: fileURLToPath(
          new URL("./packages/notifications/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@moss/priority",
        replacement: fileURLToPath(new URL("./packages/priority/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/settings",
        replacement: fileURLToPath(new URL("./packages/settings/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/settings-ui",
        replacement: fileURLToPath(new URL("./packages/settings-ui/src/index.tsx", import.meta.url))
      },
      {
        find: "@moss/settings-ui/vite",
        replacement: fileURLToPath(new URL("./packages/settings-ui/src/vite.ts", import.meta.url))
      },
      {
        find: "@moss/shared",
        replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/sports",
        replacement: fileURLToPath(new URL("./packages/sports/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/source-behaviors",
        replacement: fileURLToPath(
          new URL("./packages/source-behaviors/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@moss/tasks",
        replacement: fileURLToPath(new URL("./packages/tasks/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/usefulness-feedback",
        replacement: fileURLToPath(
          new URL("./packages/usefulness-feedback/src/index.ts", import.meta.url)
        )
      },
      {
        find: "@moss/web-research",
        replacement: fileURLToPath(new URL("./packages/web-research/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/memory",
        replacement: fileURLToPath(new URL("./packages/memory/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/vault",
        replacement: fileURLToPath(new URL("./packages/vault/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/structured-state",
        replacement: fileURLToPath(
          new URL("./packages/structured-state/src/index.ts", import.meta.url)
        )
      },
      {
        // Subpath export (#1970); must precede the bare "@moss/wellness" alias below, same
        // pairing requirement as the other subpath/bare alias pairs in this file. The web
        // builder form imports this directly so the browser never pulls the wellness index.
        find: "@moss/wellness/schedule-summary",
        replacement: fileURLToPath(
          new URL("./packages/wellness/src/schedule-summary.ts", import.meta.url)
        )
      },
      {
        find: "@moss/wellness",
        replacement: fileURLToPath(new URL("./packages/wellness/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/weather",
        replacement: fileURLToPath(new URL("./packages/weather/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/workshop",
        replacement: fileURLToPath(new URL("./packages/workshop/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/people",
        replacement: fileURLToPath(new URL("./packages/people/src/index.ts", import.meta.url))
      },
      {
        find: "@moss/scratchpad",
        replacement: fileURLToPath(new URL("./packages/scratchpad/src/index.ts", import.meta.url))
      },
      // Subpath export first, same pairing requirement as the other subpath/bare pairs above.
      {
        find: "@moss/workflows/routes",
        replacement: fileURLToPath(new URL("./packages/workflows/src/routes.ts", import.meta.url))
      },
      {
        find: "@moss/workflows",
        replacement: fileURLToPath(new URL("./packages/workflows/src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    include: [
      "spikes/**/*.test.ts",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "packages/people/src/__tests__/**/*.test.ts",
      "packages/db/src/__tests__/**/*.test.ts",
      "packages/scratchpad/src/__tests__/**/*.test.ts",
      "packages/chat/src/live/*.test.ts",
      "packages/chat/src/*.test.ts",
      "packages/calendar/src/*.test.ts",
      "packages/ai/src/structured/*.test.ts"
    ],
    setupFiles: ["tests/setup-env.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: "forks",
    fileParallelism: false
  }
});
