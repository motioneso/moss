import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps same-second starts in separate logs even when both launches fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-concurrent-"));
  try {
    const bin = join(dir, "bin");
    const state = join(dir, "state");
    await mkdir(bin);
    await mkdir(state);
    expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
    await writeFile(
      join(bin, "date"),
      `#!/usr/bin/env bash
if [ "$1" = "+%Y%m%d-%H%M%S" ]; then echo 20261028-000000; else exec /bin/date "$@"; fi
`,
      { mode: 0o755 }
    );
    // No Docker daemon or database is reached. Stop after the early log has been reserved.
    await writeFile(join(bin, "docker"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const run = promisify(execFile);
    const results = await Promise.allSettled(
      ["one", "two"].map((gate) =>
        run(
          "bash",
          [resolve(__dirname, "../../scripts/run-gate.sh"), "start", "--no-sweep", "--gate", gate],
          {
            cwd: dir,
            env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, JARVIS_GATE_DIR: state },
            timeout: 8000
          }
        )
      )
    );
    expect(
      results.every(
        (result) => result.status === "rejected" && (result.reason as { code: number }).code === 4
      )
    ).toBe(true);
    const logs = (await readdir(state)).filter((name) => name.endsWith(".log"));
    expect(logs).toHaveLength(2);
    const contents = await Promise.all(logs.map((log) => readFile(join(state, log), "utf8")));
    expect(contents.map((text) => text.split("\n")[0]).sort()).toEqual([
      "### GATE   pnpm one",
      "### GATE   pnpm two"
    ]);
    expect(contents.every((text) => text.includes("### LAUNCH_FAILED"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
