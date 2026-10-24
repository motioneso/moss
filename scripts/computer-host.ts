import { parseHostConfig } from "./computer-host/config.js";
import { HostStateStore, privateJson } from "./computer-host/state.js";
import { ComputerDocker } from "./computer-host/docker.js";
import { ComputerHostOperations, unavailableAdmission } from "./computer-host/operations.js";
import { serveComputerHost } from "./computer-host/service.js";

// Opt-in internal tool. No systemd/compose install, API registration or launch admission.
// Future gateway/admission qualification must replace this unavailable port in a reviewed PR.
async function main() {
  const [configPath, ...extra] = process.argv.slice(2);
  if (!configPath || extra.length)
    throw new Error("Expected one private Computer host config path");
  process.umask(0o077);
  const config = parseHostConfig(await privateJson(configPath));
  const store = await HostStateStore.open(config);
  try {
    const service = await serveComputerHost(
      store,
      new ComputerHostOperations(store, new ComputerDocker(config), unavailableAdmission)
    );
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await service.close();
  } finally {
    await store.close();
  }
}
void main().catch(() => {
  // Configuration, daemon responses and private paths must not escape into logs.
  process.stderr.write("Computer host control unavailable\n");
  process.exitCode = 1;
});
