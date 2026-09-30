// Guards the job split in cli-tools-manifest.yml. The repository has no YAML parser, so this
// reads the workflow as text, like ci-phase-deadlines.test.ts. The split is the security
// control, so each rule below names the attack it stops.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../.github/workflows/cli-tools-manifest.yml", import.meta.url)),
  "utf8"
);

function jobBody(name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} exists`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[a-z-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function stepBody(job: string, name: string): string {
  const chunks = job.split(/^ {6}- /m);
  const hit = chunks.find((c) => c.includes(`name: ${name}`));
  expect(hit, `step ${name} exists`).toBeDefined();
  return hit!;
}

describe("cli-tools-manifest workflow", () => {
  it("never lets two runs publish at once", () => {
    expect(source).toMatch(
      /concurrency:\n {2}group: cli-tools-manifest\n {2}cancel-in-progress: false/
    );
  });

  it("keeps the signing key out of every job and step except the signing step", () => {
    const uses = [...source.matchAll(/secrets\.[A-Z_]+/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const job of ["prepare", "check"]) expect(jobBody(job)).not.toMatch(/secrets\./);
    const sign = jobBody("sign");
    const signStep = stepBody(sign, "Verify, assemble and sign the manifest");
    expect(sign.replace(signStep, "")).not.toMatch(/MOSS_MODULE_CATALOG_SIGNING/);
    expect(signStep).toMatch(/secrets\.MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY/);
  });

  it("runs the package code only in a read-only job that has no token to steal", () => {
    const check = jobBody("check");
    expect(check).toMatch(/permissions:\n {6}contents: read/);
    expect(check).not.toMatch(/contents: write|issues: write|GH_TOKEN|github\.token/);
    expect(check).toMatch(/cli\.ts check/);
    expect(jobBody("sign")).not.toMatch(/cli\.ts check/);
    expect(jobBody("prepare")).not.toMatch(/cli\.ts check/);
  });

  it("never persists checkout credentials", () => {
    const checkouts = source.match(
      /uses: actions\/checkout@v\d+\n\s+with:\n\s+persist-credentials: false/g
    );
    expect(checkouts).toHaveLength(3);
    expect(source.match(/actions\/checkout@/g)).toHaveLength(3);
  });

  it("makes signing wait for the check job and for the environment gate", () => {
    const sign = jobBody("sign");
    expect(sign).toMatch(/needs: \[prepare, check\]/);
    expect(sign).toMatch(
      /environment: \$\{\{ github\.event_name == 'workflow_dispatch' && 'cli-tools-signing-manual' \|\| 'cli-tools-signing' \}\}/
    );
  });

  it("only gives the write token to the signing job", () => {
    expect(jobBody("prepare")).not.toMatch(/contents: write|issues: write/);
    expect(jobBody("sign")).toMatch(/contents: write/);
    expect(source.split("\n  sign:")[0]).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("passes manual inputs through the environment, never into a shell line", () => {
    for (const line of source.split("\n").filter((l) => l.includes("inputs."))) {
      expect(line).toMatch(
        /^\s+INPUT_(PACKAGE|VERSION): \$\{\{ inputs\.(package|version) \}\}$|^\s+(package|version):/
      );
    }
  });

  it("files an issue per blocked update and one when the publish itself fails", () => {
    expect(source).toContain('TITLE="CLI tool update blocked: $PKG $VER"');
    expect(source).toContain('TITLE="CLI tools manifest publish is failing"');
  });
});
