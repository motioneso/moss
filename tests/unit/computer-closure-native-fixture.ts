import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClosureCapture } from "../../scripts/computer-closure/capture.js";
import { hostJsonRequest } from "../../apps/api/src/computer/host-http.js";
import { closureFile, recheckClosureFile } from "../../scripts/computer-closure/files.js";
import type {
  ClosureConfiguration,
  ClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { verifyComputerClosure, CLOSURE_DEADLINE_MS } from "../../scripts/computer-closure/run.js";
import { inspectRoots } from "../../scripts/computer-host/config.js";
import { computerMonotonicMs } from "../../scripts/computer-watchdog/linux.js";
import { assertRoot } from "../../scripts/computer-watchdog/linux-files.js";

// Deliberately replaces installed root/namespace/provenance validation and loopback readiness.
// All observations, Docker inventory, PID/group proof, socket probes, signatures/fsync are real.
const startedAtMs = computerMonotonicMs();
const timer = setTimeout(() => process.exit(2), CLOSURE_DEADLINE_MS);
let interrupted = false;
process.on("SIGTERM", () => {
  interrupted = true;
});
process.on("SIGINT", () => {
  interrupted = true;
});
async function main() {
  const configPath = process.argv[2]!;
  const configuration = JSON.parse(await readFile(configPath, "utf8")) as ClosureConfiguration;
  const file = await closureFile(
    join(configuration.supervisor.capture!.path, "capture.json"),
    65536
  );
  const historical = JSON.parse(file.bytes.toString("utf8")) as Omit<ClosureCapture, "file">;
  const deployment: ClosureDeployment = {
    configuration,
    config: await closureFile(configPath, 16384),
    keyFile: await closureFile(configuration.signingKeyPath, 4096),
    installationFile: await closureFile(configuration.installationPath, 16384),
    capture: { ...historical, file },
    signingKey: createPrivateKey(await readFile(configuration.signingKeyPath)),
    artifactPath: process.argv[1]!,
    nodePath: process.execPath,
    anchors: {
      artifact: "disclosed fixture",
      node: "disclosed fixture",
      dockerSocket: "disclosed fixture"
    },
    roots: await inspectRoots(configuration.supervisor.host)
  };
  return verifyComputerClosure(deployment, {
    startedAtMs,
    interrupted: () => interrupted,
    revalidate: async (d) => {
      await recheckClosureFile(d.config);
      await recheckClosureFile(d.keyFile);
      await recheckClosureFile(d.installationFile);
      await recheckClosureFile(d.capture.file);
      for (const root of [...d.roots, d.configuration.receipt, d.configuration.supervisor.monitor])
        await assertRoot(root);
    },
    ready: async () => {
      const value = await hostJsonRequest({
        socketPath: process.argv[3]!,
        method: "GET",
        path: "/health/ready",
        limit: 4096,
        timeoutMs: 2000
      });
      if (JSON.stringify(value) !== JSON.stringify({ ok: true, db: "ok", pgboss: "ok" }))
        throw new Error("fixture unhealthy");
    }
  });
}
void main().then(
  (code) => {
    clearTimeout(timer);
    process.exit(code);
  },
  () => {
    clearTimeout(timer);
    process.exit(2);
  }
);
