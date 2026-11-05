import { AsyncLocalStorage } from "node:async_hooks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const scope = new AsyncLocalStorage<{ readonly actorUserId: string }>();

const requestOwners = new WeakMap<object, string>();

/** Remembers who a request is for, so a later callback hook can open the owner scope. */
export function rememberRequestLogOwner(request: object, actorUserId: string): void {
  if (UUID.test(actorUserId)) requestOwners.set(request, actorUserId);
}

/**
 * Runs `next` inside the owner scope of this request. Call it from a callback-style hook, so the
 * handler that follows runs in the same async flow. A request with no remembered owner runs
 * unscoped.
 */
export function continueInRequestLogOwner(request: object, next: () => void): void {
  const actorUserId = requestOwners.get(request);
  if (actorUserId) scope.run({ actorUserId }, next);
  else next();
}

/** Runs `fn` with the owner bound for its whole async flow, then restores the previous scope. */
export function runWithLogOwner<T>(actorUserId: string, fn: () => T): T {
  return scope.run({ actorUserId }, fn);
}

/**
 * Adds the current owner to a log record as a top-level field. A shared logger calls this on
 * each record, so a long-lived client reports the user it is working for. Outside any scope, and
 * when the record already names an owner, the record is returned unchanged.
 */
export function withCurrentLogOwner(data: Record<string, unknown>): Record<string, unknown> {
  const owner = scope.getStore();
  if (!owner || "actorUserId" in data) return data;
  return { ...data, actorUserId: owner.actorUserId };
}
