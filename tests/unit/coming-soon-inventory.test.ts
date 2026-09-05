import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function read(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

const settingsUiSource = read("packages/settings-ui/src/index.tsx");
const auditPaneSource = read("apps/web/src/settings/settings-audit-pane.tsx");
const notificationsSource = read("apps/web/src/settings/settings-module-subviews.tsx");

function findUnlabeledSoonMarkers(dirRelPath: string): string[] {
  const dirPath = path.join(ROOT, dirRelPath);
  const violations: string[] = [];
  for (const file of readdirSync(dirPath)) {
    if (!file.endsWith(".tsx")) continue;
    const source = readFileSync(path.join(dirPath, file), "utf8");
    const markerPattern = /Coming soon|\bSoon\b/g;
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(source)) !== null) {
      const windowStart = Math.max(0, match.index - 60);
      const windowEnd = Math.min(source.length, match.index + 60);
      const nearby = source.slice(windowStart, windowEnd);
      if (!/#\d+/.test(nearby)) {
        violations.push(`${file}: "${match[0]}" has no nearby #<issue> reference`);
      }
    }
  }
  return violations;
}

describe("coming-soon tracker contract", () => {
  it("requires Row's future-badge prop to be a numeric issue reference, not a boolean", () => {
    expect(settingsUiSource).not.toMatch(/coming\?:\s*boolean/);
    expect(settingsUiSource).toMatch(/comingIssue\?:\s*number/);
  });

  it("requires ComingSoon to take an issue number and render the badge with it", () => {
    const match = settingsUiSource.match(
      /function ComingSoon\(props: \{ readonly issue: number \}\) \{([\s\S]*?)\n\}/
    );
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain("Coming soon");
    expect(body).toContain("props.issue");
  });

  it("removes the dead, uncalled shell ComingSoon helper", () => {
    expect(existsSync(path.join(ROOT, "apps/web/src/shell/coming-soon.tsx"))).toBe(false);
  });

  it("maps Export instance data and Backup & restore to their live delivery issues", () => {
    expect(auditPaneSource).toMatch(
      /name="Export instance data"[\s\S]{0,120}comingIssue=\{?1069\}?/
    );
    expect(auditPaneSource).toMatch(/name="Backup & restore"[\s\S]{0,120}comingIssue=\{?1070\}?/);
    expect(auditPaneSource).not.toMatch(/\bcoming\b(?!Issue)/);
  });

  it("no longer marks Push notifications as coming soon (#743 shipped)", () => {
    expect(notificationsSource).not.toMatch(/name="Push"[\s\S]{0,160}comingIssue/);
  });

  it("has no unlabeled coming-soon or standalone Soon markers in onboarding", () => {
    expect(findUnlabeledSoonMarkers("apps/web/src/onboarding")).toEqual([]);
  });
});
