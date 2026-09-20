import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkBaseBranchCollisions,
  checkCrossPrCollisions,
  checkLocalDuplicates,
  excludeOwnPullRequest,
  findLocalMigrationFiles,
  getCurrentBranchName,
  parseMigrationPath,
  type ClaimSource,
  type MigrationFile
} from "../../scripts/check-migration-collisions.ts";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixtureDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-migration-collisions-"));
  fixtureRoots.push(root);
  return root;
}

describe("check-migration-collisions (Issue #2371)", () => {
  describe("parseMigrationPath", () => {
    it("parses infra migrations", () => {
      const parsed = parseMigrationPath("infra/postgres/migrations/0001_app_schema.sql");
      expect(parsed).toEqual({
        path: "infra/postgres/migrations/0001_app_schema.sql",
        version: "0001",
        filename: "0001_app_schema.sql",
        checksum: undefined
      });
    });

    it("parses package module migrations", () => {
      const parsed = parseMigrationPath("packages/sports/sql/0133_sports_follows.sql");
      expect(parsed).toEqual({
        path: "packages/sports/sql/0133_sports_follows.sql",
        version: "0133",
        filename: "0133_sports_follows.sql",
        checksum: undefined
      });
    });

    it("parses package src/sql migrations (e.g. proactive-monitoring)", () => {
      const parsed = parseMigrationPath(
        "packages/proactive-monitoring/src/sql/0122_proactive_monitoring.sql"
      );
      expect(parsed).toEqual({
        path: "packages/proactive-monitoring/src/sql/0122_proactive_monitoring.sql",
        version: "0122",
        filename: "0122_proactive_monitoring.sql",
        checksum: undefined
      });
    });

    it("normalizes leading dot-slash and backslashes", () => {
      const parsed = parseMigrationPath(".\\packages\\email\\sql\\0219_email_thread.sql");
      expect(parsed?.path).toBe("packages/email/sql/0219_email_thread.sql");
      expect(parsed?.version).toBe("0219");
    });

    it("pads numbers with fewer than 4 digits", () => {
      const parsed = parseMigrationPath("infra/postgres/migrations/5_audit.sql");
      expect(parsed?.version).toBe("0005");
    });

    it("rejects non-migration sql files", () => {
      expect(parseMigrationPath("spikes/auth-rls-safety/sql/000_roles.sql")).toBeNull();
      expect(parseMigrationPath("infra/postgres/bootstrap/001_roles.sql")).toBeNull();
      expect(parseMigrationPath("infra/postgres/grants/001_grants.sql")).toBeNull();
      expect(parseMigrationPath("packages/ai/src/gateway/gateway.ts")).toBeNull();
    });

    it("rejects unversioned sql files in migration directories", () => {
      expect(parseMigrationPath("infra/postgres/migrations/schema_draft.sql")).toBeNull();
      expect(parseMigrationPath("packages/email/sql/temp.sql")).toBeNull();
    });
  });

  describe("checkLocalDuplicates", () => {
    it("returns no violations when all versions are distinct", () => {
      const files: MigrationFile[] = [
        {
          path: "infra/postgres/migrations/0001_init.sql",
          version: "0001",
          filename: "0001_init.sql"
        },
        { path: "packages/tasks/sql/0003_tasks.sql", version: "0003", filename: "0003_tasks.sql" },
        { path: "packages/email/sql/0012_email.sql", version: "0012", filename: "0012_email.sql" }
      ];

      expect(checkLocalDuplicates(files)).toEqual([]);
    });

    it("flags duplicate version numbers across different directories", () => {
      const files: MigrationFile[] = [
        {
          path: "packages/commitments/sql/0220_add_commitments.sql",
          version: "0220",
          filename: "0220_add_commitments.sql"
        },
        {
          path: "packages/email/sql/0220_email_thread_lookup.sql",
          version: "0220",
          filename: "0220_email_thread_lookup.sql"
        }
      ];

      const violations = checkLocalDuplicates(files);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("duplicate_local");
      expect(violations[0]?.version).toBe("0220");
      expect(violations[0]?.message).toContain("packages/commitments/sql/0220_add_commitments.sql");
      expect(violations[0]?.message).toContain("packages/email/sql/0220_email_thread_lookup.sql");
    });
  });

  describe("checkBaseBranchCollisions", () => {
    const baseFiles: MigrationFile[] = [
      {
        path: "infra/postgres/migrations/0001_init.sql",
        version: "0001",
        filename: "0001_init.sql",
        checksum: "hash_0001"
      },
      {
        path: "packages/commitments/sql/0220_commitments.sql",
        version: "0220",
        filename: "0220_commitments.sql",
        checksum: "hash_0220_base"
      }
    ];

    it("allows new higher version numbers on the branch", () => {
      const localFiles: MigrationFile[] = [
        ...baseFiles,
        {
          path: "packages/workshop/sql/0228_workshop.sql",
          version: "0228",
          filename: "0228_workshop.sql",
          checksum: "hash_0228"
        }
      ];

      expect(checkBaseBranchCollisions(localFiles, baseFiles)).toEqual([]);
    });

    it("flags when a branch reuses an existing base version with a different file", () => {
      const localFiles: MigrationFile[] = [
        baseFiles[0]!,
        {
          path: "packages/email/sql/0220_email_thread_lookup.sql",
          version: "0220",
          filename: "0220_email_thread_lookup.sql",
          checksum: "hash_different"
        }
      ];

      const violations = checkBaseBranchCollisions(localFiles, baseFiles);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("main_collision");
      expect(violations[0]?.version).toBe("0220");
      expect(violations[0]?.message).toContain("packages/commitments/sql/0220_commitments.sql");
      expect(violations[0]?.message).toContain("packages/email/sql/0220_email_thread_lookup.sql");
    });

    it("flags when an existing migration on base is edited (checksum mismatch)", () => {
      const localFiles: MigrationFile[] = [
        baseFiles[0]!,
        {
          path: "packages/commitments/sql/0220_commitments.sql",
          version: "0220",
          filename: "0220_commitments.sql",
          checksum: "hash_0220_MODIFIED"
        }
      ];

      const violations = checkBaseBranchCollisions(localFiles, baseFiles);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("main_collision");
      expect(violations[0]?.version).toBe("0220");
      expect(violations[0]?.message).toContain("was edited after being applied/committed");
    });
  });

  describe("excludeOwnPullRequest", () => {
    const pullRequests = [
      { headRefName: "feature-a" },
      { headRefName: "feature-b" },
      { headRefName: "feature-c" }
    ];

    it("drops the pull request opened from the checked-out branch", () => {
      expect(excludeOwnPullRequest(pullRequests, "feature-b")).toEqual([
        { headRefName: "feature-a" },
        { headRefName: "feature-c" }
      ]);
    });

    it("keeps every pull request on a detached HEAD", () => {
      expect(excludeOwnPullRequest(pullRequests, undefined)).toEqual(pullRequests);
    });

    it("keeps every pull request when the branch has none open", () => {
      expect(excludeOwnPullRequest(pullRequests, "feature-d")).toEqual(pullRequests);
    });
  });

  describe("getCurrentBranchName", () => {
    it("uses the workflow branch name when the checkout is detached", () => {
      expect(getCurrentBranchName(process.cwd(), { GITHUB_HEAD_REF: "feature-a" })).toBe(
        "feature-a"
      );
    });

    it("ignores an empty workflow branch name and asks git", () => {
      const fromGit = getCurrentBranchName(process.cwd(), {});
      expect(getCurrentBranchName(process.cwd(), { GITHUB_HEAD_REF: "  " })).toBe(fromGit);
    });
  });

  describe("checkCrossPrCollisions", () => {
    it("returns no violations when PRs claim disjoint migration numbers", () => {
      const claims: ClaimSource[] = [
        {
          label: 'PR #2540 ("Feature A")',
          file: {
            path: "packages/tasks/sql/0229_tasks.sql",
            version: "0229",
            filename: "0229_tasks.sql"
          }
        },
        {
          label: 'PR #2542 ("Feature B")',
          file: {
            path: "packages/notes/sql/0230_notes.sql",
            version: "0230",
            filename: "0230_notes.sql"
          }
        }
      ];

      expect(checkCrossPrCollisions(claims)).toEqual([]);
    });

    it("flags collision when two open PRs claim the same migration version number", () => {
      const claims: ClaimSource[] = [
        {
          label: 'PR #2500 ("Feature Alpha")',
          file: {
            path: "packages/tasks/sql/0229_tasks_alpha.sql",
            version: "0229",
            filename: "0229_tasks_alpha.sql"
          }
        },
        {
          label: 'PR #2501 ("Feature Beta")',
          file: {
            path: "packages/email/sql/0229_email_beta.sql",
            version: "0229",
            filename: "0229_email_beta.sql"
          }
        }
      ];

      const violations = checkCrossPrCollisions(claims);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("cross_pr_collision");
      expect(violations[0]?.version).toBe("0229");
      expect(violations[0]?.message).toContain('PR #2500 ("Feature Alpha")');
      expect(violations[0]?.message).toContain('PR #2501 ("Feature Beta")');
    });

    it("flags collision between current branch and an open PR", () => {
      const claims: ClaimSource[] = [
        {
          label: "Current branch (local working copy)",
          file: {
            path: "packages/workshop/sql/0229_workshop.sql",
            version: "0229",
            filename: "0229_workshop.sql"
          }
        },
        {
          label: 'PR #2510 ("In-flight migration")',
          file: {
            path: "packages/sports/sql/0229_sports.sql",
            version: "0229",
            filename: "0229_sports.sql"
          }
        }
      ];

      const violations = checkCrossPrCollisions(claims);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("cross_pr_collision");
      expect(violations[0]?.version).toBe("0229");
      expect(violations[0]?.message).toContain("Current branch (local working copy)");
      expect(violations[0]?.message).toContain('PR #2510 ("In-flight migration")');
    });

    it("flags when an open PR claims a version already on base branch", () => {
      const baseFiles: MigrationFile[] = [
        {
          path: "packages/connectors/sql/0215_connector_sync.sql",
          version: "0215",
          filename: "0215_connector_sync.sql"
        }
      ];
      const claims: ClaimSource[] = [
        {
          label: 'PR #2520 ("Reused number")',
          file: {
            path: "packages/news/sql/0215_news_new.sql",
            version: "0215",
            filename: "0215_news_new.sql"
          }
        }
      ];

      const violations = checkCrossPrCollisions(claims, baseFiles);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.kind).toBe("cross_pr_collision");
      expect(violations[0]?.version).toBe("0215");
      expect(violations[0]?.message).toContain("already exists on base branch");
    });
  });

  describe("findLocalMigrationFiles fixture scan", () => {
    it("scans and indexes migration files with checksums", async () => {
      const root = await buildFixtureDir();
      await mkdir(join(root, "infra/postgres/migrations"), { recursive: true });
      await mkdir(join(root, "packages/sports/sql"), { recursive: true });
      await mkdir(join(root, "packages/proactive-monitoring/src/sql"), { recursive: true });

      await writeFile(join(root, "infra/postgres/migrations/0001_init.sql"), "SELECT 1;");
      await writeFile(join(root, "packages/sports/sql/0010_sports.sql"), "SELECT 2;");
      await writeFile(
        join(root, "packages/proactive-monitoring/src/sql/0020_monitoring.sql"),
        "SELECT 3;"
      );

      const found = await findLocalMigrationFiles(root);
      expect(found).toHaveLength(3);
      expect(found.map((f) => f.version)).toEqual(["0001", "0010", "0020"]);
      expect(found.every((f) => Boolean(f.checksum))).toBe(true);
    });

    it("passes against the live repository tree with zero duplicate violations", async () => {
      const repoRoot = process.cwd();
      const files = await findLocalMigrationFiles(repoRoot);
      expect(files.length).toBeGreaterThan(200);

      const duplicates = checkLocalDuplicates(files);
      expect(duplicates).toEqual([]);
    });
  });
});
