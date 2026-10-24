import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClosureConfiguration } from "../../scripts/computer-closure/config.js";
import type { ClosureCapture } from "../../scripts/computer-closure/capture.js";
import type { RootIdentity } from "../../scripts/computer-host/config.js";
import { closureFile } from "../../scripts/computer-closure/files.js";
import { sha256 } from "../../scripts/computer-watchdog/trust.js";

/** Constructed historical samples: excluded from actual capture publication provenance. */
export async function constructedClosureCapture(
  config: ClosureConfiguration,
  roots: readonly RootIdentity[],
  journalPath: string
): Promise<ClosureCapture> {
  const bytes = await readFile(journalPath);
  const prefix = bytes.subarray(0, bytes.indexOf(10) + 1);
  const { dev, ino } = await lstat(journalPath);
  const { startedAtMs } = JSON.parse(prefix.toString("utf8")).configuration;
  const namespaces = {
    ...config.supervisor.namespaces,
    net: config.netNamespace,
    cgroup: await readlink("/proc/self/ns/cgroup")
  };
  const journal = { dev, ino, size: prefix.length, hash: sha256(prefix) };
  const value = {
    version: 1,
    kind: "managed-process-snapshot",
    coverage: "sampled-cgroup-v2",
    runId: config.supervisor.runId,
    binding: config.supervisor.lifetime!.binding,
    measuredAtMs: startedAtMs,
    finishedAtMs: startedAtMs,
    runner: config.supervisor.runner,
    watchdog: config.processes.watchdog,
    inits: (["desktop", "gateway"] as const).map((role) => ({
      role,
      id:
        role === "desktop"
          ? config.supervisor.lifetime!.binding.desktopId
          : config.supervisor.lifetime!.binding.gatewayId,
      pid: config.processes[role].pid,
      identity: config.processes[role],
      startedAt: "2026-10-24T00:00:00.000Z"
    })),
    groups: {
      namespaces: { net: namespaces.net, cgroup: namespaces.cgroup },
      pair: [],
      root: {},
      mountId: "1"
    },
    provenance: {
      roots,
      bootId: config.supervisor.bootId,
      namespaces,
      files: [],
      lock: {},
      socket: {}
    },
    journal
  };
  const path = join(config.supervisor.capture!.path, "capture.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return {
    file: await closureFile(path, 65536),
    measuredAtMs: startedAtMs,
    finishedAtMs: startedAtMs,
    journal
  };
}
