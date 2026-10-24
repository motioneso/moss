import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { readHostJson } from "../../apps/api/src/computer/host-http.js";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { ComputerDocker } from "../computer-host/docker.js";
import { parseState, privateJson } from "../computer-host/state.js";
import {
  collectComputerLinuxMeasurements,
  computerMonotonicMs,
  readComputerProcess
} from "./linux.js";
import {
  assertNullOutputs,
  assertTrustedPath,
  revalidateDeployment,
  supervisorError,
  type SupervisorDeployment
} from "./trust.js";
import type { WatchdogProcessIdentity, WatchdogSample } from "./policy.js";
import { assertRoot } from "./linux-files.js";
import { inspectJournal } from "./journal.js";

/** Native HTTP has no proxy/redirect handling. Status and complete body share one absolute deadline. */
export function checkMossReadiness(readyUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(readyUrl);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(url, { method: "GET", agent: false, rejectUnauthorized: true });
    const timer = setTimeout(() => outgoing.destroy(supervisorError()), 2000);
    const fail = () => {
      clearTimeout(timer);
      reject(supervisorError());
    };
    outgoing.once("error", fail);
    outgoing.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        fail();
        return;
      }
      void readHostJson(response, 4096)
        .then((value) => {
          if (
            !isRecord(value) ||
            Object.keys(value).sort().join(",") !== "db,ok,pgboss" ||
            value.ok !== true ||
            value.db !== "ok" ||
            value.pgboss !== "ok"
          )
            throw supervisorError();
          resolve();
        })
        .catch(() => {
          response.destroy();
          fail();
        })
        .finally(() => clearTimeout(timer));
    });
    outgoing.end();
  });
}

export async function checkComputerLogs(deployment: SupervisorDeployment): Promise<void> {
  const { configuration: config } = deployment;
  const state = parseState(await privateJson(join(config.host.stateDir, "state.json")));
  if (state.resources.some((resource) => resource.id === null)) throw supervisorError();
  const inventory = await new ComputerDocker(config.host).inventory(state.resources);
  for (const entry of inventory) {
    const id = entry.resource.id;
    const directory = join(config.dockerData.path, "containers", id);
    const name = `${id}-json.log`;
    if (entry.logPath !== join(directory, name)) throw supervisorError();
    await assertTrustedPath(directory, true);
    const iterator = await opendir(directory, { bufferSize: 16 });
    let count = 0;
    const logs = new Set<string>();
    try {
      for (;;) {
        const entry = await iterator.read();
        if (!entry) break;
        if (++count > 256) throw supervisorError();
        if (!entry.name.startsWith(name)) continue;
        if (![name, `${name}.1`].includes(entry.name)) throw supervisorError();
        logs.add(entry.name);
        const stat = await lstat(join(directory, entry.name));
        if (
          !stat.isFile() ||
          stat.uid !== 0 ||
          stat.nlink !== 1 ||
          (stat.mode & 0o022) !== 0 ||
          stat.size >= 2 * 1024 ** 2 ||
          stat.blocks * 512 >= 2 * 1024 ** 2
        )
          throw supervisorError();
      }
    } finally {
      await iterator.close();
    }
    if (!logs.has(name)) throw supervisorError();
  }
  if (
    JSON.stringify(parseState(await privateJson(join(config.host.stateDir, "state.json")))) !==
    JSON.stringify(state)
  )
    throw supervisorError();
}

/** Read-only sampled proof. No launch authority or lifecycle mutation. */
export async function observeComputer(
  deployment: SupervisorDeployment,
  watchdog: WatchdogProcessIdentity
): Promise<WatchdogSample> {
  const measuredAtMs = computerMonotonicMs();
  try {
    await revalidateDeployment(deployment);
    const { configuration: config } = deployment;
    if (
      watchdog.pid === config.runner.pid ||
      watchdog.processGroupId === config.runner.processGroupId
    )
      throw supervisorError();
    await assertNullOutputs(watchdog.pid);
    const statePath = join(config.host.stateDir, "state.json");
    const beforeState = JSON.stringify(parseState(await privateJson(statePath)));
    await checkMossReadiness(config.readyUrl);
    await checkComputerLogs(deployment);
    await inspectJournal(config.monitor);
    const home = deployment.roots.find((root) => root.path === config.host.homeDir);
    const socket = deployment.roots.find((root) => root.path === config.host.guestSocketDir);
    if (!home || !socket) throw supervisorError();
    const measurements = await collectComputerLinuxMeasurements({
      runner: config.runner,
      watchdog,
      home,
      socket,
      data: config.data
    });
    await revalidateDeployment(deployment);
    await assertRoot(config.monitor);
    await readComputerProcess(watchdog);
    if (JSON.stringify(parseState(await privateJson(statePath))) !== beforeState)
      throw supervisorError();
    return Object.freeze({
      ...measurements,
      measuredAtMs,
      runId: config.runId,
      mossHealthy: true,
      logsBounded: true,
      stopRequested: false
    });
  } catch {
    throw supervisorError();
  }
}
