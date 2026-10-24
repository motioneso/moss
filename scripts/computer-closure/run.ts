import { basename } from "node:path";
import { computerMonotonicMs } from "../computer-watchdog/linux.js";
import { checkMossReadiness } from "../computer-watchdog/observe.js";
import { processIdentity, supervisorError } from "../computer-watchdog/trust.js";
import { revalidateClosureDeployment, type ClosureDeployment } from "./config.js";
import { observeClosure } from "./observe.js";
import { readClosureRecords, recheckClosureRecords } from "./records.js";
import { ClosureReceipt, type ClosureObservations } from "./receipt.js";

export const CLOSURE_DEADLINE_MS = 60_000;
export interface ClosureExecution {
  readonly startedAtMs: number;
  readonly now?: () => number;
  readonly interrupted: () => boolean;
  readonly revalidate?: typeof revalidateClosureDeployment;
  readonly ready?: typeof checkMossReadiness;
}

/** Distinct-process composition. Injection ports are for disclosed native tooling tests only. */
export async function verifyComputerClosure(
  deployment: ClosureDeployment,
  execution: ClosureExecution
): Promise<0 | 2> {
  const now = execution.now ?? computerMonotonicMs;
  const revalidate = execution.revalidate ?? revalidateClosureDeployment;
  let lastTime = execution.startedAtMs;
  const assertCurrent = () => {
    const at = now();
    if (
      !Number.isSafeInteger(at) ||
      at < lastTime ||
      at - execution.startedAtMs >= CLOSURE_DEADLINE_MS ||
      execution.interrupted()
    )
      throw supervisorError();
    lastTime = at;
    return at;
  };
  let receipt: ClosureReceipt | undefined;
  let observations: ClosureObservations = {
    files: null,
    collectors: null,
    endpointsSha256: null,
    lockPresent: null
  };
  try {
    assertCurrent();
    const verifier = await processIdentity(process.pid);
    await revalidate(deployment);
    assertCurrent();
    receipt = await ClosureReceipt.create(deployment, verifier, execution.startedAtMs);
    await receipt.append("attempt", assertCurrent(), observations);
    const records = await readClosureRecords(deployment);
    observations = {
      ...observations,
      files: Object.fromEntries(records.files.map((file) => [basename(file.path), file.hash])),
      collectors: records.collectors,
      lockPresent: records.lockPresent
    };
    assertCurrent();
    const before = await observeClosure(deployment, records, execution.ready ?? checkMossReadiness);
    observations = { ...observations, endpointsSha256: before };
    assertCurrent();
    await recheckClosureRecords(records);
    await revalidate(deployment);
    assertCurrent();
    const after = await observeClosure(deployment, records, execution.ready ?? checkMossReadiness);
    if (after !== before) throw supervisorError();
    await recheckClosureRecords(records);
    await revalidate(deployment);
    await receipt.append("observed-closed", assertCurrent(), observations);
    await receipt.close();
    const published = receipt;
    receipt = undefined;
    // Persistence and close must finish before final equality and the native success decision.
    await recheckClosureRecords(records);
    await revalidate(deployment);
    await published.assertPublished();
    assertCurrent();
    return 0;
  } catch {
    if (receipt) {
      try {
        await receipt.append("failed", now(), observations);
      } catch {
        /* Retain partial evidence. */
      }
      try {
        await receipt.close();
      } catch {
        /* Failure never becomes successful closure. */
      }
    }
    return 2;
  }
}
