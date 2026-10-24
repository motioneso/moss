import { computerMonotonicMs } from "./computer-watchdog/linux.js";
import { supervisorError } from "./computer-watchdog/trust.js";
import { loadSigningDeployment } from "./computer-signing/config.js";
import { installClosureSigner, SIGNING_DEADLINE_MS } from "./computer-signing/run.js";

const startedAtMs = computerMonotonicMs();
const timer = setTimeout(() => process.exit(2), SIGNING_DEADLINE_MS);
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
  const deployment = await loadSigningDeployment(path, process.argv[1]);
  return installClosureSigner(deployment, { startedAtMs, interrupted: () => interrupted });
}
void main().then(
  (code) => {
    const at = computerMonotonicMs();
    const success =
      code === 0 && !interrupted && at >= startedAtMs && at - startedAtMs < SIGNING_DEADLINE_MS;
    clearTimeout(timer);
    process.exit(success ? 0 : 2);
  },
  () => {
    clearTimeout(timer);
    process.exit(2);
  }
);
