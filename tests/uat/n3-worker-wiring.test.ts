import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planWorkerObserver } from "./n3-worker-wiring.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "n3-wiring-"));
  dirs.push(root);
  mkdirSync(join(root, "infra"));
  mkdirSync(join(root, "tests/uat"), { recursive: true });
  for (const file of [
    "Dockerfile",
    ".dockerignore",
    "infra/docker-compose.prod.yml",
    "tests/uat/compose.override.yml"
  ])
    writeFileSync(join(root, file), file);
  const evidence = mkdtempSync(join(tmpdir(), "n3-wiring-ev-"));
  dirs.push(evidence);
  const calls: string[] = [];
  const read = (command: string, args: readonly string[]) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "rev-parse") return "a".repeat(40);
    if (command === "docker" && args[0] === "context" && args[1] === "show") return "default";
    if (args[0] === "context") return JSON.stringify("unix:///var/run/docker.sock");
    if (args[0] === "info") return JSON.stringify("DAEMON-ID");
    throw new Error("unexpected read");
  };
  return { root, evidence, calls, read };
}

describe("N3 worker observer plan", () => {
  it("builds pins from direct reads and names the project before provisioning", () => {
    const f = fixture();
    const plan = planWorkerObserver({
      evidenceDir: f.evidence,
      repoRoot: f.root,
      claimedPort: 5201,
      imageTag: "uat-n3-abc",
      deadline: Date.now() + 600_000,
      read: f.read
    });
    expect(plan.runId.projectName).toBe(`uat-${plan.runId.suffix}`);
    expect(plan.runId.suffix).toMatch(new RegExp(`^${process.pid}_[a-f0-9]{8}$`));
    expect(plan.authority.project).toBe(plan.runId.projectName);
    expect(plan.authority.port).toBe(5201);
    expect(plan.authority.imageReference).toBe("ghcr.io/motioneso/moss:uat-n3-abc");
    expect(plan.authority.volumes.map((v) => v.id)).toEqual([
      `${plan.runId.projectName}_jarv1s-cli-auth`,
      `${plan.runId.projectName}_jarv1s-cli-socket`,
      `${plan.runId.projectName}_jarv1s-sports-browser-socket`
    ]);
    expect(plan.authority.producer.pid).toBe(process.pid);
    expect(plan.authority.channel.mode).toBe(0o700);
    expect(plan.lifecycleEnv.JARVIS_UAT_LIFECYCLE_DIR).toBe(join(f.evidence, "lifecycle"));
    expect(plan.lifecycleEnv.JARVIS_UAT_LIFECYCLE_NONCE).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.option.nonce).not.toBe(plan.lifecycleEnv.JARVIS_UAT_LIFECYCLE_NONCE);
    expect(plan.authority.source.commit).toBe("a".repeat(40));
    expect(f.calls.some((call) => call.startsWith("docker info"))).toBe(true);
  });

  it("refuses an expired observer deadline and starts no child", () => {
    const f = fixture();
    expect(() =>
      planWorkerObserver({
        evidenceDir: f.evidence,
        repoRoot: f.root,
        claimedPort: 5201,
        imageTag: "uat-n3-abc",
        deadline: Date.now() - 1,
        read: f.read
      })
    ).toThrow();
  });

  it("gives each plan its own project name, nonce and lifecycle directory", () => {
    const a = fixture();
    const b = fixture();
    const make = (f: ReturnType<typeof fixture>) =>
      planWorkerObserver({
        evidenceDir: f.evidence,
        repoRoot: f.root,
        claimedPort: 5201,
        imageTag: "uat-n3-abc",
        deadline: Date.now() + 600_000,
        read: f.read
      });
    const one = make(a);
    const two = make(b);
    expect(one.runId.projectName).not.toBe(two.runId.projectName);
    expect(one.option.nonce).not.toBe(two.option.nonce);
  });
});
