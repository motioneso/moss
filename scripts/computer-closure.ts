import { computerMonotonicMs } from "./computer-watchdog/linux.js";
import { supervisorError } from "./computer-watchdog/trust.js";
import { loadClosureDeployment } from "./computer-closure/config.js";
import { CLOSURE_DEADLINE_MS, verifyComputerClosure } from "./computer-closure/run.js";

const startedAtMs = computerMonotonicMs();
// Installed before startup I/O; hangs and repeated signals cannot refresh the absolute bound.
const timer = setTimeout(() => process.exit(2), CLOSURE_DEADLINE_MS);
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
  const deployment = await loadClosureDeployment(path, process.argv[1]);
  return verifyComputerClosure(deployment, { startedAtMs, interrupted: () => interrupted });
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
