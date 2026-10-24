import { parseHostConfig } from "./computer-host/config.js";
import { HostStateStore, privateJson } from "./computer-host/state.js";
import { ComputerDocker } from "./computer-host/docker.js";
import { ComputerTerminalHost } from "./computer-host/terminal.js";
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const operations = new ComputerTerminalHost(store, new ComputerDocker(config), {
    now: () => Number(process.hrtime.bigint() / 1000000n),
    terminal: () => {
      deadline = setTimeout(() => process.exit(2), 120_000);
    },
    stopRoot: () => {
      void operations.finish(null);
    }
  });
  const stop = () => operations.stop();
  process.on("SIGTERM", stop).on("SIGINT", stop);
  try {
    const service = await serveComputerHost(store, operations);
    await operations.completed;
    await service.close({ drain: true });
    await store.close();
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop).off("SIGINT", stop);
  }
}
void main().catch(() => {
  // Configuration, daemon responses and private paths must not escape into logs.
  process.stderr.write("Computer host control unavailable\n");
  process.exit(1);
});
