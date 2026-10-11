import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(".github/workflows/app-actions-uat.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};

describe("hosted app-actions browser proof", () => {
  it("runs the credential-free wrapper through the isolated gate", () => {
    expect(packageJson.scripts["test:uat:3065"]).toBe(
      "tsx tests/uat/run-app-actions-uat.ts scripted"
    );
    expect(source).toContain("scripts/run-gate.sh start --gate test:uat:3065");
    expect(source).toContain("scripts/run-gate.sh wait --follow");
    expect(source).not.toContain("test:uat:3065-real");
    expect(source).not.toMatch(/pnpm (?:db:up|db:migrate|test:integration)/);
  });

  it("keeps real mode opt-in, captures off and checkout credentials unpersisted", () => {
    expect(packageJson.scripts["test:uat:3065-real"]).toBe(
      "tsx tests/uat/run-app-actions-uat.ts real"
    );
    expect(source).toContain('MOSS_UAT_CAPTURE_OFF: "1"');
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("contents: read");
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("1533");
  });

  it("cannot select real mode from a stale inherited environment variable", () => {
    const wrapper = readFileSync("tests/uat/run-app-actions-uat.ts", "utf8");
    expect(wrapper).toContain('const mode = process.argv[2] ?? "scripted"');
    expect(wrapper).not.toContain("process.env.MOSS_APP_ACTIONS_UAT_MODE");
  });

  it("states the ACP and live-proof limits rather than claiming automatic or real-model proof", () => {
    expect(source).toContain("Verify app action approval and screen refresh");
    expect(source).toContain("clean-engine browser automatic proof are not run here");
  });

  it("runs again when the shared harness or app-action evidence helper changes", () => {
    for (const path of [
      "tests/uat/*.ts",
      "tests/uat/specs/app-actions-*.ts",
      "apps/web/**",
      "packages/module-sdk/**",
      "scripts/run-gate.sh"
    ])
      expect(source).toContain(`"${path}"`);
  });
});
