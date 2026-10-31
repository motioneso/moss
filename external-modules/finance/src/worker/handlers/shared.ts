// external-modules/finance/src/worker/handlers/shared.ts
//
// FIN-04 (#1149) Task 4: share / unshare an account into the household
// mirror. One core (`applyShareFlag`) serves both the assistant tool
// (finance.account.set-shared, D4-blocked on the invoke route like every
// write) and the finance.share-apply queue twin — same split as
// budget.assign / budget.apply.
//
// Both directions are idempotent SETs: the flag write and the mirror
// write/delete converge under the queue's retryLimit-1 replay. The mirror is
// a projection (spec delta §"Mirror contract") — every key this file writes
// or deletes is under the actor's own `{actorUserId}:` prefix by
// construction, and the projection helpers are explicit allowlists, so
// neither foreign prefixes nor undeclared fields (notes, itemId, status) can
// ever reach instance scope.
import {
  sharedAccountPrefix,
  sharedMetaKey,
  sharedMonthKey,
  toSharedAccountMeta,
  toSharedChunk
} from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readBool, readString } from "../validate.js";

type ShareCommand = {
  readonly actorUserId: string;
  readonly accountId: string;
  readonly shared: boolean;
};

export async function applyShareFlag(
  ports: WorkerPorts,
  command: ShareCommand
): Promise<{ status: "ok"; accountId: string; shared: boolean }> {
  const { actorUserId, accountId, shared } = command;
  const store = await ports.store();
  const account = await store.getAccount(accountId);
  if (account === null) {
    throw new InputError("unknown_account", "accountId is not on record");
  }
  if (shared && account.source === "manual") {
    throw new InputError(
      "manual_sharing_unavailable",
      "Manual accounts are private while household ledger sharing is being added"
    );
  }
  // Flag first, mirror second, in the SAME invocation (spec delta §"Share /
  // unshare semantics"): a crash between the two leaves a stale mirror that
  // the next sync's own-prefix reconcile (ON→OFF) or replay (OFF→ON) heals.
  await store.putAccount({ ...account, sharedToHousehold: shared });

  if (shared) {
    await ports.mirror.set(
      sharedMetaKey(actorUserId, accountId),
      toSharedAccountMeta(actorUserId, account)
    );
    // Every stored month for this account — mirror writes stay on the
    // instance KV port (FIN-06c #1166 Task 9), only the source read moves.
    for (const month of await store.listTransactionMonths()) {
      const transactions = await store.getTransactionChunk(accountId, month);
      if (transactions === null) continue;
      await ports.mirror.set(
        sharedMonthKey(actorUserId, accountId, month),
        toSharedChunk({ transactions })
      );
    }
  } else {
    // Unshare deletes the FULL account prefix (meta + every month) — the
    // epic-spec "unshare removes the mirror" requirement, verified by test.
    const prefix = sharedAccountPrefix(actorUserId, accountId);
    for (const key of await ports.mirror.list()) {
      if (key.startsWith(prefix)) await ports.mirror.delete(key);
    }
  }
  return { status: "ok", accountId, shared };
}

/**
 * Assistant-tool surface. `actorUserId` is HOST-BOUND: the API host injects
 * it spread-last over caller input at the dispatch chokepoint
 * (apps/api/src/external-module-tools.ts), so a caller-smuggled value never
 * survives — see spec delta "Host change 2".
 */
export const accountSetSharedHandler: ToolFactory = (ports) => async (input) => {
  const actorUserId = readString(input, "actorUserId", { required: true });
  const accountId = readString(input, "accountId", { required: true });
  const shared = readBool(input, "shared", { required: true });
  return applyShareFlag(ports, { actorUserId, accountId, shared });
};

/** Queue twin of account.set-shared — consumes the host job envelope. */
export const shareApplyHandler: ToolFactory = (ports) => async (input) => {
  const actorUserId = readString(input, "actorUserId", { required: true });
  const jobKind = readString(input, "jobKind", { required: true });
  if (jobKind !== "finance.share-apply") {
    throw new InputError("jobKind is not supported by this handler");
  }
  const params = input.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  const command = params as Record<string, unknown>;
  const accountId = readString(command, "accountId", { required: true });
  const shared = readBool(command, "shared", { required: true });
  return applyShareFlag(ports, { actorUserId, accountId, shared });
};
