import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migration Path & Filename Constants.
 *
 * Migrations live in:
 *  - infra/postgres/migrations/<version>_<name>.sql
 *  - packages/<package>/sql/<version>_<name>.sql
 *  - packages/<package>/src/sql/<version>_<name>.sql
 *
 * Version numbers are numeric prefixes followed by an underscore (e.g. 0220_...).
 */
export const MIGRATION_PATH_PATTERN =
  /^(?:infra\/postgres\/migrations|packages\/[^/]+\/(?:src\/)?sql)\/([^/]+)$/;

export const MIGRATION_FILENAME_PATTERN = /^(\d+)_([a-zA-Z0-9_-]+)\.sql$/;

export interface MigrationFile {
  readonly path: string;
  readonly version: string;
  readonly filename: string;
  readonly checksum?: string;
}

export interface PrMigrationClaim {
  readonly prNumber: number;
  readonly prTitle: string;
  readonly prUrl: string;
  readonly files: readonly MigrationFile[];
}

export interface CollisionViolation {
  readonly kind: "duplicate_local" | "main_collision" | "cross_pr_collision";
  readonly version: string;
  readonly message: string;
}

/**
 * Normalizes a relative path and extracts its migration metadata if it is a migration file.
 */
export function parseMigrationPath(relativePath: string, checksum?: string): MigrationFile | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = normalized.match(MIGRATION_PATH_PATTERN);
  if (!match) return null;

  const filename = match[1];
  if (!filename) return null;

  const fileMatch = filename.match(MIGRATION_FILENAME_PATTERN);
  if (!fileMatch) {
    return null;
  }

  const rawVersion = fileMatch[1];
  if (!rawVersion) return null;

  const version = rawVersion.padStart(4, "0");
  return {
    path: normalized,
    version,
    filename,
    checksum
  };
}

/**
 * Verifies that no two migration files in the provided set share the same version number.
 */
export function checkLocalDuplicates(files: readonly MigrationFile[]): CollisionViolation[] {
  const byVersion = new Map<string, MigrationFile[]>();
  for (const file of files) {
    const list = byVersion.get(file.version) ?? [];
    list.push(file);
    byVersion.set(file.version, list);
  }

  const violations: CollisionViolation[] = [];
  for (const [version, group] of byVersion) {
    if (group.length > 1) {
      const fileList = group.map((f) => `    - ${f.path}`).join("\n");
      violations.push({
        kind: "duplicate_local",
        version,
        message: `Migration version ${version} is claimed by multiple files in repository:\n${fileList}`
      });
    }
  }

  return violations;
}

/**
 * Verifies that migrations in localFiles do not clash with or unsafely modify migrations on baseFiles.
 */
export function checkBaseBranchCollisions(
  localFiles: readonly MigrationFile[],
  baseFiles: readonly MigrationFile[]
): CollisionViolation[] {
  const baseByVersion = new Map<string, MigrationFile>();
  for (const file of baseFiles) {
    baseByVersion.set(file.version, file);
  }

  const violations: CollisionViolation[] = [];

  for (const local of localFiles) {
    const base = baseByVersion.get(local.version);
    if (!base) continue;

    if (base.path !== local.path) {
      violations.push({
        kind: "main_collision",
        version: local.version,
        message:
          `Migration version ${local.version} already exists on base branch with a different name/path:\n` +
          `    - Base branch:    ${base.path}\n` +
          `    - Current branch: ${local.path}`
      });
    } else if (base.checksum && local.checksum && base.checksum !== local.checksum) {
      violations.push({
        kind: "main_collision",
        version: local.version,
        message:
          `Migration version ${local.version} (${local.path}) was edited after being applied/committed to base branch (checksum mismatch).\n` +
          `    Applied migrations are immutable. Add a new forward migration instead.`
      });
    }
  }

  return violations;
}

export interface ClaimSource {
  readonly label: string;
  readonly file: MigrationFile;
}

/**
 * Checks for collision across open pull requests and optionally against baseFiles.
 */
export function checkCrossPrCollisions(
  claims: readonly ClaimSource[],
  baseFiles?: readonly MigrationFile[]
): CollisionViolation[] {
  const violations: CollisionViolation[] = [];

  const baseByVersion = new Map<string, MigrationFile>();
  if (baseFiles) {
    for (const file of baseFiles) {
      baseByVersion.set(file.version, file);
    }
  }

  // 1. Check if any PR claim collides with an existing migration on base
  for (const claim of claims) {
    const base = baseByVersion.get(claim.file.version);
    if (base && base.path !== claim.file.path) {
      violations.push({
        kind: "cross_pr_collision",
        version: claim.file.version,
        message:
          `Migration version ${claim.file.version} claimed by ${claim.label} already exists on base branch:\n` +
          `    - Base branch: ${base.path}\n` +
          `    - ${claim.label}: ${claim.file.path}`
      });
    }
  }

  // 2. Group claims by version and check for multiple distinct PR claimants
  const byVersion = new Map<string, ClaimSource[]>();
  for (const claim of claims) {
    const list = byVersion.get(claim.file.version) ?? [];
    list.push(claim);
    byVersion.set(claim.file.version, list);
  }

  for (const [version, group] of byVersion) {
    // Unique claimants by label
    const uniqueLabels = new Set(group.map((g) => g.label));
    if (uniqueLabels.size > 1) {
      const claimDetails = group.map((g) => `    - ${g.label}: ${g.file.path}`).join("\n");
      violations.push({
        kind: "cross_pr_collision",
        version,
        message: `Migration version ${version} is claimed by multiple open pull requests:\n${claimDetails}`
      });
    }
  }

  return violations;
}

/**
 * Scans the filesystem starting from rootDirectory for all valid migration files.
 */
export async function findLocalMigrationFiles(rootDirectory: string): Promise<MigrationFile[]> {
  const migrationFiles: MigrationFile[] = [];

  async function scanDir(dirPath: string) {
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootDirectory, fullPath).replace(/\\/g, "/");

      if (entry.isFile() && entry.name.endsWith(".sql")) {
        const parsed = parseMigrationPath(relPath);
        if (parsed) {
          const contents = await readFile(fullPath);
          const checksum = createHash("sha256").update(contents).digest("hex");
          migrationFiles.push({ ...parsed, checksum });
        }
      }
    }
  }

  // 1. infra/postgres/migrations
  await scanDir(join(rootDirectory, "infra/postgres/migrations"));

  // 2. packages/*/sql and packages/*/src/sql
  const packagesDir = join(rootDirectory, "packages");
  try {
    const packageEntries = await readdir(packagesDir, { withFileTypes: true });
    for (const pkg of packageEntries) {
      if (pkg.isDirectory()) {
        await scanDir(join(packagesDir, pkg.name, "sql"));
        await scanDir(join(packagesDir, pkg.name, "src", "sql"));
      }
    }
  } catch {
    // packages directory may not exist in minimal fixtures
  }

  return migrationFiles.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Queries git to list all migration files present on baseRef.
 */
export function getBaseBranchMigrationFiles(
  baseRef: string = "origin/main",
  cwd: string = process.cwd()
): MigrationFile[] | null {
  // Determine if baseRef is resolvable in git
  let targetRef = baseRef;
  try {
    execFileSync("git", ["rev-parse", "--verify", targetRef], { cwd, stdio: "ignore" });
  } catch {
    if (targetRef === "origin/main") {
      try {
        execFileSync("git", ["rev-parse", "--verify", "main"], { cwd, stdio: "ignore" });
        targetRef = "main";
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  try {
    const rawOutput = execFileSync(
      "git",
      ["ls-tree", "-r", targetRef, "--", "infra/postgres/migrations", "packages"],
      { cwd, encoding: "utf8" }
    );

    const files: MigrationFile[] = [];
    for (const line of rawOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Output format: <mode> blob <hash>\t<path>
      const tabIdx = trimmed.indexOf("\t");
      if (tabIdx === -1) continue;
      const meta = trimmed.slice(0, tabIdx);
      const filePath = trimmed.slice(tabIdx + 1);
      const parts = meta.split(/\s+/);
      const blobHash = parts[2];

      const parsed = parseMigrationPath(filePath);
      if (parsed) {
        // We can fetch the raw content to calculate sha256 or use blob hash
        let checksum: string | undefined;
        try {
          const content = execFileSync("git", ["show", `${targetRef}:${filePath}`], {
            cwd,
            stdio: ["ignore", "pipe", "ignore"]
          });
          checksum = createHash("sha256").update(content).digest("hex");
        } catch {
          checksum = blobHash;
        }
        files.push({ ...parsed, checksum });
      }
    }

    return files.sort((a, b) => a.version.localeCompare(b.version));
  } catch {
    return null;
  }
}

/**
 * Queries the GitHub CLI to retrieve all open PRs and the migration files they introduce.
 */
export async function getOpenPrMigrationClaims(
  cwd: string = process.cwd()
): Promise<PrMigrationClaim[] | null> {
  try {
    const prListRaw = execFileSync(
      "gh",
      ["pr", "list", "--state", "open", "--json", "number,title,url,headRefName"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );

    const openPrs: { number: number; title: string; url: string; headRefName: string }[] =
      JSON.parse(prListRaw);

    const claims: PrMigrationClaim[] = [];

    await Promise.all(
      openPrs.map(async (pr) => {
        try {
          const diffFilesRaw = execFileSync(
            "gh",
            ["pr", "diff", String(pr.number), "--name-only"],
            {
              cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"]
            }
          );

          const migrationFiles: MigrationFile[] = [];
          for (const line of diffFilesRaw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = parseMigrationPath(trimmed);
            if (parsed) {
              migrationFiles.push(parsed);
            }
          }

          if (migrationFiles.length > 0) {
            claims.push({
              prNumber: pr.number,
              prTitle: pr.title,
              prUrl: pr.url,
              files: migrationFiles
            });
          }
        } catch {
          // If individual PR diff fails, continue with others
        }
      })
    );

    return claims;
  } catch {
    return null;
  }
}

export interface CheckMigrationOptions {
  readonly rootDirectory?: string;
  readonly baseRef?: string;
  readonly skipPrCheck?: boolean;
}

export interface CheckMigrationResult {
  readonly violations: readonly CollisionViolation[];
  readonly localCount: number;
  readonly baseCount: number;
  readonly prClaimsCount: number;
}

export async function checkMigrationCollisions(
  options: CheckMigrationOptions = {}
): Promise<CheckMigrationResult> {
  const root = options.rootDirectory ?? process.cwd();
  const baseRef = options.baseRef ?? "origin/main";

  // 1. Local filesystem discovery and duplicates check
  const localFiles = await findLocalMigrationFiles(root);
  const localViolations = checkLocalDuplicates(localFiles);

  // 2. Base branch comparison
  const baseFiles = getBaseBranchMigrationFiles(baseRef, root);
  const baseViolations = baseFiles ? checkBaseBranchCollisions(localFiles, baseFiles) : [];

  // 3. Cross-PR check (if not skipped and gh CLI is available)
  let prClaimsCount = 0;
  const prViolations: CollisionViolation[] = [];

  if (!options.skipPrCheck) {
    const prClaims = await getOpenPrMigrationClaims(root);
    if (prClaims) {
      prClaimsCount = prClaims.length;

      // Identify migrations new in the current working copy compared to base branch
      const baseVersionSet = new Set((baseFiles ?? []).map((b) => b.version));
      const localNewFiles = localFiles.filter((f) => !baseVersionSet.has(f.version));

      const claimSources: ClaimSource[] = [];

      // Add local branch new migrations as a claimant
      for (const file of localNewFiles) {
        claimSources.push({
          label: "Current branch (local working copy)",
          file
        });
      }

      // Add open PR claims
      for (const pr of prClaims) {
        for (const file of pr.files) {
          claimSources.push({
            label: `PR #${pr.prNumber} ("${pr.prTitle}")`,
            file
          });
        }
      }

      prViolations.push(...checkCrossPrCollisions(claimSources, baseFiles ?? undefined));
    }
  }

  const allViolations = [...localViolations, ...baseViolations, ...prViolations];
  return {
    violations: allViolations,
    localCount: localFiles.length,
    baseCount: baseFiles ? baseFiles.length : 0,
    prClaimsCount
  };
}

export async function main(): Promise<void> {
  const result = await checkMigrationCollisions();

  if (result.violations.length > 0) {
    console.error("Database migration number collision(s) detected:\n");
    for (const violation of result.violations) {
      console.error(`- [${violation.kind}] ${violation.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const prNote =
    result.prClaimsCount > 0
      ? `, checked across ${result.prClaimsCount} open PR(s)`
      : " (cross-PR check skipped or no PR claims)";

  console.log(
    `No migration number collisions found (${result.localCount} local migrations checked against ${result.baseCount} on base branch${prNote}).`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
