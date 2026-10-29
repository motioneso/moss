import { readComputerGatewayConfig } from "./computer-gateway/config.js";
import { serveComputerGateway } from "../apps/api/src/computer/gateway-server.js";

// Opt-in separate executable; no image, installation or runtime-admission bypass.
async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error("Computer gateway unavailable");
  process.umask(0o077);
  let stopping = false;
  let resolveStop: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const signal = () => {
    stopping = true;
    resolveStop();
  };
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  try {
    const config = await readComputerGatewayConfig(path);
    if (stopping) return;
    const service = await serveComputerGateway(config);
    try {
      if (!stopping) process.stdout.write("Computer gateway listening\n");
      if (!stopping) await Promise.race([stop, service.done]);
      if (!stopping) process.exitCode = 1;
    } finally {
      await service.close();
    }
  } finally {
    process.off("SIGTERM", signal);
    process.off("SIGINT", signal);
  }
}
void main().catch(() => {
  process.stderr.write("Computer gateway unavailable\n");
  process.exitCode = 1;
});
