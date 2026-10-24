import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { HostStateStore } from "../computer-host/state.js";
import { ComputerDocker } from "../computer-host/docker.js";
import { assertEmptyOutput, ProvisionPublication } from "../computer-provision/publication.js";
import type { ObservationJournal } from "../computer-watchdog/journal.js";
import { computerMonotonicMs } from "../computer-watchdog/linux.js";
import {
  processIdentity,
  supervisorError,
  type SupervisorDeployment
} from "../computer-watchdog/trust.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";
import { captureCgroupPair } from "./cgroups.js";
import { captureProvenance } from "./provenance.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Native managed-root snapshot only. No lifecycle lock acquisition or closure/admission authority. */
export async function captureManagedProcesses(
  deployment: SupervisorDeployment,
  store: HostStateStore | undefined,
  watchdog: WatchdogProcessIdentity,
  startedAtMs: number,
  journal: ObservationJournal,
  interrupted: () => boolean
): Promise<void> {
  const measuredAtMs = computerMonotonicMs(); // Before first capture I/O; never freshened.
  const { configuration: config } = deployment;
  let last = measuredAtMs;
  const current = () => {
    const at = computerMonotonicMs();
    if (
      !Number.isSafeInteger(startedAtMs) ||
      startedAtMs < 0 ||
      at < last ||
      at - startedAtMs >= 5000 ||
      interrupted()
    )
      throw supervisorError();
    last = at;
    store?.assertNotStopped();
  };
  current();
  if (
    !store ||
    !config.capture ||
    !config.lifetime ||
    !same(store.config, config.host) ||
    watchdog.pid !== process.pid ||
    !same(await processIdentity(process.pid), watchdog)
  )
    throw supervisorError();
  const lockedStore = store;
  const configuration = { runId: config.runId, startedAtMs, runner: config.runner, watchdog };
  const provenance = await captureProvenance(deployment, lockedStore);
  current();
  const start = await journal.startSnapshot(configuration);
  const docker = new ComputerDocker(config.host);
  const observe = async () => {
    current();
    const pair = await docker.runningPair(lockedStore.state.resources);
    const inits = await Promise.all(
      pair.map(async (entry) => {
        if (!entry.process) throw supervisorError();
        return {
          id: entry.resource.id,
          role: entry.resource.role,
          pid: entry.process.pid,
          startedAt: entry.process.startedAt,
          identity: await processIdentity(entry.process.pid)
        };
      })
    );
    if (new Set(inits.map((i) => i.pid)).size !== 2) throw supervisorError();
    const groups = await captureCgroupPair(inits, [watchdog, config.runner]);
    current();
    return { inits, groups };
  };
  const sample = await observe();
  const check = async () => {
    current();
    if (
      !same(provenance, await captureProvenance(deployment, lockedStore)) ||
      !same(start, await journal.startSnapshot(configuration)) ||
      !same(sample, await observe())
    )
      throw supervisorError();
    current();
  };
  await assertEmptyOutput(config.capture);
  await check();
  const publication = await ProvisionPublication.create(
    config.capture,
    "capture.json",
    {
      version: 1,
      kind: "managed-process-snapshot",
      coverage: "sampled-cgroup-v2",
      runId: config.runId,
      binding: config.lifetime.binding,
      measuredAtMs,
      finishedAtMs: computerMonotonicMs(),
      watchdog,
      runner: config.runner,
      ...sample,
      provenance,
      journal: start
    },
    0o600,
    config.capture.gid,
    check,
    current
  );
  // create returned only after file and directory closes. Repeat all pinned observations/readback.
  await check();
  await publication.assertPublished();
  current();
  try {
    lstatSync(join(config.host.stateDir, "stop.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      current();
      return;
    }
    throw error;
  }
  throw supervisorError();
}
