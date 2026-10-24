import { isRecord } from "../apps/api/src/computer/host-contract.js";
import { computerMonotonicMs, readComputerProcess } from "./computer-watchdog/linux.js";
import { observeComputer } from "./computer-watchdog/observe.js";
import { superviseDeployment } from "./computer-watchdog/supervisor.js";
import { manageDeployment } from "./computer-watchdog/managed-host.js";
import {
  loadSupervisorDeployment,
  processIdentity,
  supervisorError
} from "./computer-watchdog/trust.js";

const startedAtMs = computerMonotonicMs();
// Bootstrap cannot wait indefinitely for untrusted/missing configuration or a stuck mount.
const startupDeadline = setTimeout(() => process.exit(2), 5000);
async function main(): Promise<number> {
  const [mode, configPath, ...rest] = process.argv.slice(2);
  if (
    !["observe", "fence", "manage", "collect"].includes(mode ?? "") ||
    !configPath ||
    rest.length ||
    !process.argv[1]
  )
    throw supervisorError();
  const deployment = await loadSupervisorDeployment(
    configPath,
    process.argv[1],
    mode === "collect"
  );
  if (
    ((mode === "fence" || mode === "manage") && !deployment.configuration.lifetime) ||
    (mode === "observe" && deployment.configuration.lifetime)
  )
    throw supervisorError();
  if (mode === "collect") {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16384) throw supervisorError();
      chunks.push(buffer);
    }
    const record: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !isRecord(record) ||
      Object.keys(record).sort().join(",") !== "configSha256,runId,watchdog" ||
      record.runId !== deployment.configuration.runId ||
      record.configSha256 !== deployment.configSha256 ||
      !isRecord(record.watchdog)
    )
      throw supervisorError();
    const watchdog = await readComputerProcess(
      record.watchdog as unknown as Parameters<typeof readComputerProcess>[0]
    );
    const sample = await observeComputer(deployment, {
      pid: watchdog.pid,
      startTicks: watchdog.startTicks,
      processGroupId: watchdog.processGroupId
    });
    const output = JSON.stringify({ runId: deployment.configuration.runId, sample });
    if (Buffer.byteLength(output) > 16384) throw supervisorError();
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(output, (error) => (error ? reject(supervisorError()) : resolve()))
    );
    return 0;
  }
  const watchdog = await processIdentity(process.pid);
  if (
    watchdog.pid === deployment.configuration.runner.pid ||
    watchdog.processGroupId === deployment.configuration.runner.processGroupId
  )
    throw supervisorError();
  // Journal startup is still under the independent bootstrap deadline. Driver owns later deadlines.
  if (mode === "manage")
    return manageDeployment(deployment, startedAtMs, watchdog, () => clearTimeout(startupDeadline));
  const result = superviseDeployment(deployment, startedAtMs, watchdog, () =>
    clearTimeout(startupDeadline)
  );
  // Do not clear until creation has settled: superviseDeployment installs timers after its await.
  // Its first policy tick includes all startup time.
  const outcome = await result;
  return outcome.exitCode;
}
void main().then(
  (code) => {
    clearTimeout(startupDeadline);
    process.exit(code);
  },
  () => {
    clearTimeout(startupDeadline);
    process.exit(2);
  }
);
