import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const rootDirectory = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "playwright-report/**",
      "test-results/**",
      "Jarvis Design System/**",
      ".claude/worktrees/**",
      ".claude/workflows/**",
      "docs/audit/**",
      "docs/audits/**",
      // #1326: unit-test fixtures mkdtemp() a ".tmp-*" directory directly in the repo
      // root (external-worker-runtime, external-module-invocation-budget,
      // module-sdk-worker) rather than os.tmpdir(); a concurrent lint run can otherwise
      // enumerate one mid-test and crash with ENOENT when the test's afterEach removes
      // it first.
      "**/.tmp-*/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Restored standalone CommonJS preview checks use Node and Playwright browser globals.
    files: [".superpowers/brainstorm/today-briefings-20260909/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    // These ordered classic scripts share top-level bindings through index.html.
    files: [".superpowers/brainstorm/today-briefings-20260909/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: [".superpowers/brainstorm/today-briefings-20260909/evening-plan.js"],
    languageOptions: {
      globals: {
        loopDecision: "writable",
        mode: "writable",
        query: "readonly",
        render: "readonly",
        scheduling: "readonly",
        tomorrowSaved: "writable"
      }
    }
  },
  {
    files: [".superpowers/brainstorm/today-briefings-20260909/morning-briefing.js"],
    languageOptions: {
      globals: {
        accepted: "writable",
        announce: "readonly",
        heading: "readonly",
        minuteLabel: "readonly",
        mode: "writable",
        planningDialog: "readonly",
        query: "readonly",
        quietNight: "readonly",
        render: "readonly",
        safeText: "readonly",
        schedule: "readonly",
        scheduling: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^(morningAgenda|morningSlot)$"
        }
      ]
    }
  },
  {
    files: [".superpowers/brainstorm/today-briefings-20260909/study.js"],
    languageOptions: {
      globals: {
        morningAgenda: "readonly",
        morningSaved: "readonly",
        morningSlot: "readonly",
        openEveningPlan: "readonly",
        openMorningBriefing: "readonly"
      }
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: rootDirectory
      }
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          ignoreRestSiblings: true
        }
      ]
    }
  },
  {
    // JS-06 (#935): external-module web surfaces compile JSX through the classic pragma
    // (esbuild jsxFactory `h` / jsxFragment `Fragment`, resolved off the host runtime
    // global — see scripts/build-external-module.ts). No react eslint plugin is loaded
    // for this tree, so JSX-only `h`/`Fragment` imports look unused to no-unused-vars.
    files: ["external-modules/*/src/web/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^(h|Fragment)$"
        }
      ]
    }
  },
  {
    files: ["**/*.test.ts", "vitest.config.ts"],
    languageOptions: {
      globals: {
        ...globals.vitest
      }
    }
  },
  {
    files: ["apps/web/**/*.{js,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        caches: "readonly",
        self: "readonly"
      }
    }
  },
  {
    // #802: module boundary enforcement. Packages/apps may only reach into another
    // workspace package through its declared public exports — never its `src/` internals.
    // Scoped to `packages/*/src` and `apps/*/src`; test dirs are exempt (tests may reach
    // into source, per the existing `settings-sports-pane.test.tsx` pattern).
    //
    // Flat-config merge trap: a later `no-restricted-imports` config REPLACES an earlier
    // one for any file the later block also matches — it does not merge. `apps/web/src`
    // matches both this general boundary block and the lucide-ban block below, so the
    // apps/web/src-specific block below carries BOTH `paths` and `patterns` in one rule
    // entry to stay in effect there. This block covers packages/*/src and the non-web apps
    // (api, worker) where only the boundary patterns apply.
    files: ["packages/*/src/**/*.{js,ts,tsx}", "apps/*/src/**/*.{js,ts,tsx}"],
    ignores: ["**/tests/**", "**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@moss/*/src/*"],
              message: "Deep import into another package's src. Use its public exports."
            },
            {
              group: ["../../*/src/*", "../../../*/src/*", "../../../../*/src/*"],
              message:
                "Relative import crossing a package boundary. Depend on the package and use its public exports."
            },
            {
              group: ["**/packages/*/src/*"],
              message:
                "Path import into a workspace package's src. Depend on the package and use its public exports."
            }
          ]
        }
      ]
    }
  },
  {
    // apps/web/src is covered by BOTH the boundary rule above and the #685 lucide ban
    // below; flat config lets a later `no-restricted-imports` entry fully replace an
    // earlier one for the same file, so this block (later, more specific) merges both
    // concerns into one rule entry rather than silently dropping one of them.
    files: ["apps/web/src/**/*.{js,ts,tsx}"],
    ignores: ["**/tests/**", "**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              importNames: ["Sparkles"],
              message:
                "Sparkles is a banned AI-tell marker (#685). Use GitCommitHorizontal for Jarvis-held/generated items or BrandMark for product identity."
            }
          ],
          patterns: [
            {
              group: ["@moss/*/src/*"],
              message: "Deep import into another package's src. Use its public exports."
            },
            {
              group: ["../../*/src/*", "../../../*/src/*", "../../../../*/src/*"],
              message:
                "Relative import crossing a package boundary. Depend on the package and use its public exports."
            },
            {
              group: ["**/packages/*/src/*"],
              message:
                "Path import into a workspace package's src. Depend on the package and use its public exports."
            }
          ]
        }
      ]
    }
  }
);
