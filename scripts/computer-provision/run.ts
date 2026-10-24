import { lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseComputerLifetime } from "../../apps/api/src/computer/lifetime-protocol.js";
import {
  readComputerGatewayConfig,
  parseComputerGatewayConfig
} from "../computer-gateway/config.js";
import { closureFile, recheckClosureFile } from "../computer-closure/files.js";
import { ComputerDocker } from "../computer-host/docker.js";
import { HostStateStore } from "../computer-host/state.js";
import { computerMonotonicMs } from "../computer-watchdog/linux.js";
import {
  loadSupervisorDeployment,
  revalidateDeployment,
  supervisorError
} from "../computer-watchdog/trust.js";
import { revalidateProvisionDeployment, type ProvisionDeployment } from "./config.js";
import { assertEmptyOutput, ProvisionPublication } from "./publication.js";

export const PROVISION_DEADLINE_MS = 60_000;
export interface ProvisionExecution {
  readonly startedAtMs: number;
  readonly now?: () => number;
  readonly interrupted: () => boolean;
}
/** Concrete stopped-pair delivery, not launch admission or process-capture provenance. */
export async function provisionCreatedComputerRun(
  deployment: ProvisionDeployment,
  execution: ProvisionExecution
): Promise<0 | 2> {
  const now = execution.now ?? computerMonotonicMs;
  let last = execution.startedAtMs;
  const current = () => {
    const at = now();
    if (
      !Number.isSafeInteger(at) ||
      at < last ||
      at - execution.startedAtMs >= PROVISION_DEADLINE_MS ||
      execution.interrupted()
    )
      throw supervisorError();
    last = at;
  };
  let store: HostStateStore | undefined;
  try {
    current();
    await revalidateProvisionDeployment(deployment);
    current();
    const { supervisor, output, supervisorArtifactPath } = deployment.configuration;
    store = await HostStateStore.openExisting(supervisor.host, { retainFailedLock: true });
    const lockedStore = store;
    // From this point failures intentionally retain the exclusive lifecycle lock path.
    const state = store.state;
    const stateFiles = await Promise.all(
      ["identity.json", "state.json"].map((name) =>
        closureFile(join(supervisor.host.stateDir, name), 16384)
      )
    );
    const docker = new ComputerDocker(supervisor.host);
    const publications: ProvisionPublication[] = [];
    const check = async () => {
      current();
      await revalidateProvisionDeployment(deployment);
      await lockedStore.assertRoots();
      await lockedStore.assertLaunchable();
      for (const file of stateFiles) await recheckClosureFile(file);
      for (const publication of publications) await publication.assertPublished();
      current();
      lockedStore.assertNotStopped();
    };
    await check();
    if (!state.enabled || state.generation <= 0) throw supervisorError();
    await docker.createdPair(state.resources);
    await assertEmptyOutput(output);
    await check();
    const desktop = state.resources.find((r) => r.role === "desktop")!;
    const gateway = state.resources.find((r) => r.role === "gateway")!;
    const lifetime = parseComputerLifetime({
      secret: randomBytes(32).toString("hex"),
      binding: {
        runId: supervisor.runId,
        instanceId: supervisor.host.instanceId,
        requestGeneration: state.generation,
        desktopId: desktop.id,
        desktopGeneration: desktop.generation,
        gatewayId: gateway.id,
        gatewayGeneration: gateway.generation
      }
    });
    const rootConfig = await ProvisionPublication.create(
      output,
      "supervisor.json",
      { ...supervisor, lifetime },
      0o600,
      output.gid,
      check,
      current
    );
    publications.push(rootConfig);
    const rootDeployment = await loadSupervisorDeployment(
      rootConfig.path,
      supervisorArtifactPath,
      true
    );
    await check();
    const gatewayConfig = parseComputerGatewayConfig({
      ownerUserId: supervisor.host.ownerUserId,
      authSocketPath: "/auth/auth.sock",
      guestSocketPath: "/socket/viewer.sock",
      socketPath: "/ipc/gateway.sock",
      lifetime
    });
    const guestConfig = await ProvisionPublication.create(
      deployment.gateway,
      "gateway.json",
      gatewayConfig,
      0o640,
      1000,
      check,
      current
    );
    publications.push(guestConfig);
    if (
      JSON.stringify(await readComputerGatewayConfig(guestConfig.path)) !==
      JSON.stringify(gatewayConfig)
    )
      throw supervisorError();
    await revalidateDeployment(rootDeployment);
    await check();
    await docker.createdPair(state.resources);
    const completed = await ProvisionPublication.create(
      output,
      "prepared.json",
      {
        version: 1,
        runId: supervisor.runId,
        binding: lifetime.binding,
        inputSha256: deployment.input.hash,
        supervisorSha256: rootConfig.hash,
        gatewaySha256: guestConfig.hash
      },
      0o600,
      output.gid,
      check,
      current
    );
    publications.push(completed);
    await store.close({
      check: async () => {
        await docker.createdPair(state.resources);
        await revalidateDeployment(rootDeployment);
        await check();
      },
      assertCurrent: () => {
        current();
        lockedStore.assertNotStopped();
        // No awaited gap between this last on-disk stop observation and canonical unlink.
        try {
          lstatSync(join(supervisor.host.stateDir, "stop.json"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        throw supervisorError();
      }
    });
    // No fallible work after canonical lock release; native completion is still required.
    return 0;
  } catch {
    // Failure never removes the lock, including a failed final close/check.
    try {
      await store?.retainLock();
    } catch {
      /* Native timer/exit remains authoritative. */
    }
    return 2;
  }
}
