import { randomBytes } from "node:crypto";
import type { ComputerLifetimeConfiguration } from "../../apps/api/src/computer/lifetime-protocol.js";

/** Synthetic provisioned binding; no installed resources or root trust. */
export function lifetimeConfiguration(): ComputerLifetimeConfiguration {
  return {
    binding: {
      runId: "10000000-0000-4000-8000-000000000001",
      instanceId: "20000000-0000-4000-8000-000000000002",
      requestGeneration: 3,
      desktopId: "d".repeat(64),
      desktopGeneration: 1,
      gatewayId: "e".repeat(64),
      gatewayGeneration: 2
    },
    secret: randomBytes(32).toString("hex")
  };
}
