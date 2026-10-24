import { computerMonotonicMs } from "./computer-watchdog/linux.js";
import { supervisorError } from "./computer-watchdog/trust.js";
import { loadProvisionDeployment } from "./computer-provision/config.js";
import { provisionCreatedComputerRun, PROVISION_DEADLINE_MS } from "./computer-provision/run.js";

const startedAtMs = computerMonotonicMs();
const timer = setTimeout(() => process.exit(2), PROVISION_DEADLINE_MS);
let interrupted = false;
process.on("SIGTERM", () => {
  interrupted = true;
});
process.on("SIGINT", () => {
  interrupted = true;
});
async function main(): Promise<0 | 2> {
  const [path, ...rest] = process.argv.slice(2);
  if (!path || rest.length || !process.argv[1]) throw supervisorError();
  const deployment = await loadProvisionDeployment(path, process.argv[1]);
  return provisionCreatedComputerRun(deployment, { startedAtMs, interrupted: () => interrupted });
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
