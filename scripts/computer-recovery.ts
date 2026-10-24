import { parseHostConfig } from "./computer-host/config.js";
import { ComputerDocker } from "./computer-host/docker.js";
import { HostStateStore, privateJson } from "./computer-host/state.js";
import { inspectComputerRecovery, stopComputerRecovery } from "./computer-host/recovery.js";

// Opt-in root-operator tool. Actual Computer runtime requires its separately accepted exact packet.
async function main() {
  const [operation, path, ...extra] = process.argv.slice(2);
  if ((operation !== "inspect" && operation !== "stop") || !path || extra.length)
    throw new Error("Invalid Computer recovery invocation");
  process.umask(0o077);
  const config = parseHostConfig(await privateJson(path));
  const store = await HostStateStore.openExisting(config);
  try {
    const docker = new ComputerDocker(config);
    const result = await (operation === "inspect"
      ? inspectComputerRecovery(store, docker)
      : stopComputerRecovery(store, docker));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await store.close();
  }
}
void main().catch(() => {
  process.stderr.write("Computer terminal reconciliation unavailable\n");
  process.exitCode = 1;
});
