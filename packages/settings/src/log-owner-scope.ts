import { AsyncLocalStorage } from "node:async_hooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OwnerScope = { actorUserId: string | null; active: boolean };

const scope = new AsyncLocalStorage<OwnerScope>();

const requestOwners = new WeakMap<object, string>();

/** Remembers who a request is for, so a later callback hook can open the owner scope. */
export function rememberRequestLogOwner(request: object, actorUserId: string): void {
  if (UUID.test(actorUserId)) requestOwners.set(request, actorUserId);
}

/**
 * Runs `next` in a fresh owner scope for this request. Call it from a callback-style hook, so the
 * handler that follows runs in the same async flow. A request with no remembered owner runs in an
 * empty scope, so it never inherits an outer one. The scope stops applying when `response` closes,
 * so detached work that outlives the request carries no owner.
 */
export function continueInRequestLogOwner(
  request: object,
  response: { once(event: "close", listener: () => void): unknown },
  next: () => void
): void {
  const entry: OwnerScope = { actorUserId: requestOwners.get(request) ?? null, active: true };
  response.once("close", () => {
    entry.active = false;
  });
  scope.run(entry, next);
}

/** Runs `fn` with the owner bound for its whole async flow, and revokes it once `fn` settles. */
export function runWithLogOwner<T>(actorUserId: string, fn: () => T): T {
  const entry: OwnerScope = { actorUserId, active: true };
  let result: T;
  try {
    result = scope.run(entry, fn);
  } catch (error) {
    entry.active = false;
    throw error;
  }
  if (result instanceof Promise) {
    const revoke = () => {
      entry.active = false;
    };
    result.then(revoke, revoke);
  } else {
    entry.active = false;
  }
  return result;
}

/**
 * Adds the current owner to a log record as a top-level field. A shared logger calls this on
 * each record, so a long-lived client reports the user it is working for. Outside any scope, and
 * when the record already names an owner, the record is returned unchanged.
 */
export function withCurrentLogOwner(data: Record<string, unknown>): Record<string, unknown> {
  const owner = scope.getStore();
  if (!owner?.active || !owner.actorUserId || "actorUserId" in data) return data;
  return { ...data, actorUserId: owner.actorUserId };
}
