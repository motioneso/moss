import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = process.env.WORKSHOP_PROBE_ROOT;
const denied = (process.env.WORKSHOP_PROBE_DENIED_PATHS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const results = [];

function report(check, status, detail = {}) {
  const result = { check, status, ...detail };
  results.push(result);
  console.log(JSON.stringify(result));
}

function command(check, commandName, args, nonzeroStatus = "unproved", timeoutMs = 1000) {
  const result = spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL"
  });
  const status =
    result.error?.code === "ETIMEDOUT"
      ? "timeout"
      : result.error
        ? "unproved"
        : result.status === 0
          ? "pass"
          : nonzeroStatus;
  report(check, status, {
    command: commandName,
    available: !result.error,
    stdout: result.stdout?.trim() || undefined,
    stderr: result.stderr?.trim() || undefined,
    exitCode: result.status
  });
}

async function probeIdentity() {
  command("identity", "id", []);
  try {
    const status = await readFile("/proc/self/status", "utf8");
    report("capabilities", "pass", {
      effective: status.match(/^CapEff:\s*(\S+)/m)?.[1] ?? "unknown"
    });
  } catch (error) {
    report("capabilities", "unproved", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  command("user-namespace", "unshare", ["-Ur", "true"], "denied");
  command("bubblewrap", "bwrap", ["--version"]);
  command(
    "bubblewrap-boundary",
    "bwrap",
    [
      "--die-with-parent",
      "--unshare-all",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--",
      "/bin/sh",
      "-c",
      "test -r /etc/os-release && printf sandbox-ready"
    ],
    "denied"
  );
}

async function probeWorkspace() {
  if (!root) {
    report("workspace-write-read", "unproved", { reason: "WORKSHOP_PROBE_ROOT is unset" });
    return;
  }
  const file = `${root}/probe-${process.pid}.txt`;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(file, "workshop-confinement-probe\n", { flag: "wx" });
    const contents = await readFile(file, "utf8");
    report("workspace-write-read", contents === "workshop-confinement-probe\n" ? "pass" : "fail", {
      path: file
    });
  } catch (error) {
    report("workspace-write-read", "fail", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function probeDeniedPaths() {
  if (denied.length === 0) {
    report("synthetic-path-denial", "unproved", { reason: "WORKSHOP_PROBE_DENIED_PATHS is unset" });
    return;
  }
  for (const path of denied) {
    try {
      await stat(path);
    } catch {
      report(`synthetic-path-denial:${path}`, "unproved", {
        reason: "fixture path does not exist"
      });
      continue;
    }
    let readDenied = false;
    let writeDenied = false;
    try {
      await readFile(path);
    } catch {
      readDenied = true;
    }
    try {
      await writeFile(path, "workshop-confinement-probe-write\n");
    } catch {
      writeDenied = true;
    }
    report(`synthetic-path-denial:${path}`, readDenied && writeDenied ? "pass" : "fail", {
      readDenied,
      writeDenied
    });
  }
}

await probeIdentity();
await probeWorkspace();
await probeDeniedPaths();

report("network", "unproved", { reason: "requires selected provider-broker policy" });
report("process-tree-cancellation", "unproved", { reason: "requires selected runner" });
report("resource-limits", "unproved", { reason: "requires selected runner" });

process.exitCode = results.some(({ status }) => status === "fail") ? 1 : 0;
