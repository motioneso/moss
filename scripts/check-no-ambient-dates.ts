import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

/**
 * Regression guard for #579 — user-local timezone rendering.
 *
 * Every user-facing date/time in the web app must render in the user's *persisted*
 * locale (IANA timezone + 12/24-hour + BCP-47 region), routed through the single
 * sanctioned formatter module `apps/web/src/locale/locale-format.ts`. A bare
 * `Intl.DateTimeFormat` / `Date#toLocale*` in the frontend resolves to the *ambient*
 * browser zone, which is wrong for the user — exactly the bug #579 fixes. This guard
 * fails the gate if such an ambient call reappears anywhere under `apps/web/src`,
 * locking in the sweep and preventing backsliding.
 *
 * #877 finding 1 extended this to `packages/*\/src/web` (module web contributions, e.g.
 * `packages/sports/src/web`): the sports "Today" footer bug lived there, and that tree was
 * never walked by the original #579 sweep because modules render into the shell via the
 * module-web-registry, not `apps/web/src` directly. Same ambient-formatter rule applies.
 *
 * #877 finding 5 added a second, independent pattern: `new Date().toISOString().slice(0, 10)`
 * ("ambient-NOW day bucketing"). This isn't an Intl call, so it isn't caught by
 * `ambientPattern` above, but it has the same defect shape — it derives a calendar-day KEY
 * from the *server/browser-ambient* clock instead of the actor's persisted timezone, which is
 * exactly finding 5/6's UTC-day-bucketing bug pattern (tasks rolling forward at UTC midnight,
 * medication windows keyed off the wrong day). This pattern is checked across the web scan
 * roots (`apps/web/src`, `packages/*\/src/web`) AND server packages (`packages/*\/src`),
 * since ambient-NOW day bucketing is a server-side bug too (`packages/tasks/src/*` was finding
 * 2's root cause, fixed in PR #884 — this gate exists so it can't come back).
 *
 * Scope for the FIRST (Intl/toLocale*) pattern is deliberately the web display layers only.
 * Server packages thread `timeZone` explicitly (or use locale-independent `en-CA` machine keys
 * for day comparison) and are out of #579's approved scope, so they are not walked for that
 * pattern.
 *
 * EXEMPTIONS (allowlist below) are limited to non-display uses of Intl.DateTimeFormat, and to
 * ambient-NOW day keys that are not user-facing display (e.g. export filenames):
 *  - the sanctioned formatter module itself (the one place it is centralized);
 *  - `en-CA` machine-key helpers (date *keys* for streak/day math, never display).
 *  - browser timezone detection (`resolvedOptions().timeZone`) for request metadata.
 *  - export filename suffixes (a machine-readable file name, not a rendered day label).
 * No display site is exempt — route every user-facing date through locale-format.ts or the
 * shared `localDay(input, timeZone)` helper.
 */

const rootDirectory = process.cwd();
const webScanRoots = [join(rootDirectory, "apps", "web", "src"), ...(await moduleWebRoots())];
// #877 finding 5: ambient-NOW day bucketing is checked across the web roots above PLUS every
// server package's src tree (not just its web/ subdirectory).
const ambientNowScanRoots = [...webScanRoots, ...(await modulePackageRoots())];

const checkedExtensions = new Set([".ts", ".tsx"]);
const ignoredDirectories = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/** Repo-relative paths exempt from the ambient Intl/toLocale* ban. */
const allowlist = new Set<string>([
  // Sanctioned formatter module — the single place Intl.DateTimeFormat is allowed.
  "apps/web/src/locale/locale-format.ts",
  // en-CA machine-key helpers (YYYY-MM-DD day keys for streak math, not display).
  "apps/web/src/wellness/wellness-date-utils.ts",
  // #877 finding 1: sports' own copy of the sanctioned formatter (module isolation forbids
  // importing apps/web/src/* internals — see packages/sports/src/web/locale.ts's file-level
  // comment — so it duplicates the formatter, not the bug).
  "packages/sports/src/web/locale.ts",
  // Issue 2329: workshop's own copy of the sanctioned formatter, same module-isolation
  // reason as sports — see packages/workshop/src/web/locale.ts's file-level comment.
  "packages/workshop/src/web/locale.ts"
]);

/** Repo-relative paths exempt from the ambient-NOW day-bucketing ban (finding 5 pattern). */
const ambientNowAllowlist = new Set<string>([
  // Export filenames only (`wellness-export-<date>.html`, `jarvis-export-<date>.json`) — a
  // machine-readable artifact name, not a day rendered to the user. #877 finding 5 is about
  // display/scheduling day-bucketing; this is neither.
  "packages/settings/src/data-export-async-routes.ts"
]);

const ambientPattern =
  /\bnew Intl\.DateTimeFormat\b|\bIntl\.DateTimeFormat\s*\(|\.toLocaleDateString\s*\(|\.toLocaleTimeString\s*\(|\.toLocaleString\s*\(/;

// #877 finding 5: whitespace-tolerant so `.slice(0,10)` / `.slice(0, 10)` / multi-line chains
// all match — the bug is the ambient `new Date()` + ISO-day-slice shape, not exact formatting.
const ambientNowDayPattern = /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;

interface AmbientViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Scan `roots` for `pattern`, skipping `allow` and any inline `skipLine` match, into `sink`. */
async function scan(
  roots: readonly string[],
  pattern: RegExp,
  allow: ReadonlySet<string>,
  sink: AmbientViolation[],
  skipLine?: RegExp
): Promise<void> {
  const seenFiles = new Set<string>(); // roots can overlap (e.g. apps/web/src is standalone,
  // but a module's src/web is nested under its own src root) — de-dupe so a file isn't
  // scanned twice and double-reported.
  for (const root of roots) {
    for await (const filePath of walk(root)) {
      if (seenFiles.has(filePath)) {
        continue;
      }
      seenFiles.add(filePath);

      const relativePath = relative(rootDirectory, filePath);
      if (!checkedExtensions.has(extname(filePath))) {
        continue;
      }
      if (
        allow.has(relativePath) ||
        relativePath.endsWith(".test.ts") ||
        relativePath.endsWith(".test.tsx")
      ) {
        continue;
      }

      const contents = await readFile(filePath, "utf8");
      const lines = contents.split(/\r\n|\r|\n/);

      lines.forEach((text, index) => {
        if (skipLine?.test(text)) {
          return;
        }
        if (pattern.test(text)) {
          sink.push({ path: relativePath, line: index + 1, text: text.trim() });
        }
      });
    }
  }
}

const ambientViolations: AmbientViolation[] = [];
const ambientNowViolations: AmbientViolation[] = [];

await scan(
  webScanRoots,
  ambientPattern,
  allowlist,
  ambientViolations,
  /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/
);
await scan(ambientNowScanRoots, ambientNowDayPattern, ambientNowAllowlist, ambientNowViolations);

if (ambientViolations.length > 0) {
  console.error(
    "Ambient date/time formatting in the web display layer (route through apps/web/src/locale/locale-format.ts, or the module's sanctioned copy):"
  );
  for (const violation of ambientViolations) {
    console.error(`- ${violation.path}:${violation.line}  ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log("No ambient date/time formatting in the web display layer.");
}

if (ambientNowViolations.length > 0) {
  console.error(
    "\nAmbient-NOW day bucketing (#877 finding 5 — derives a calendar-day key from the " +
      "server/browser clock instead of the actor's persisted timezone; use localDay(input, tz) " +
      "from @moss/shared instead):"
  );
  for (const violation of ambientNowViolations) {
    console.error(`- ${violation.path}:${violation.line}  ${violation.text}`);
  }
  process.exitCode = 1;
} else {
  console.log("No ambient-NOW day bucketing in the scanned web/server packages.");
}

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // scan root absent (e.g. partial checkout) — nothing to check
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      yield* walk(join(directory, entry.name));
      continue;
    }
    if (entry.isFile()) {
      yield join(directory, entry.name);
    }
  }
}

/**
 * #877 finding 1: every module package's `src/web` directory (its web contribution to the
 * shell via the module-web-registry — see docs/superpowers/specs/2026-07-04-module-web-registry.md).
 * Discovered dynamically (not hardcoded to `packages/sports`) so a future module's web/ tree is
 * covered automatically instead of needing a gate update per module.
 */
async function moduleWebRoots(): Promise<string[]> {
  const packagesDir = join(rootDirectory, "packages");
  const roots: string[] = [];
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const webDir = join(packagesDir, entry.name, "src", "web");
    if (await isDirectory(webDir)) {
      roots.push(webDir);
    }
  }
  return roots;
}

/**
 * #877 finding 5: every module package's `src` root (server + web code together), for the
 * ambient-NOW day-bucketing pattern only — that bug pattern is not confined to the display
 * layer (finding 2's recurrence-roll bug was server-side), so it is checked package-wide.
 */
async function modulePackageRoots(): Promise<string[]> {
  const packagesDir = join(rootDirectory, "packages");
  const roots: string[] = [];
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const srcDir = join(packagesDir, entry.name, "src");
    if (await isDirectory(srcDir)) {
      roots.push(srcDir);
    }
  }
  return roots;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
