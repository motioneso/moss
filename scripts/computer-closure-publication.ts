import { computerMonotonicMs } from "./computer-watchdog/linux.js";
import { supervisorError } from "./computer-watchdog/trust.js";
import { loadClosurePublication } from "./computer-closure-publication/config.js";
import { publicationArguments } from "./computer-closure-publication/request.js";
import {
  PublicationClock,
  PUBLICATION_DEADLINE_MS,
  publishClosureConfiguration
} from "./computer-closure-publication/run.js";

const startedAtMs = computerMonotonicMs();
const timer = setTimeout(() => process.exit(2), PUBLICATION_DEADLINE_MS);
let interrupted = false;
process.on("SIGTERM", () => {
  interrupted = true;
});
process.on("SIGINT", () => {
  interrupted = true;
});
const clock = new PublicationClock(startedAtMs, () => interrupted);
async function main(): Promise<0 | 2> {
  const [path, hash] = publicationArguments(process.argv.slice(2));
  if (!process.argv[1]) throw supervisorError();
  clock.check();
  const deployment = await loadClosurePublication(path, hash, process.argv[1]);
  clock.check();
  return publishClosureConfiguration(deployment, clock);
}
void main().then(
  (code) => {
    let success = false;
    try {
      clock.check();
      success = code === 0;
    } catch {
      /* Silent refusal. */
    }
    clearTimeout(timer);
    process.exit(success ? 0 : 2);
  },
  () => {
    clearTimeout(timer);
    process.exit(2);
  }
);
