import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryKey, type QueryClient } from "@tanstack/react-query";

// The cache outlives mounted screens and pending work. Its reset observer must too.
// A weak client key lets the registry leave with the authenticated query client.
const sessionEpochs = new WeakMap<QueryClient, WeakMap<object, number>>();
function epochsFor(client: QueryClient) {
  let epochs = sessionEpochs.get(client);
  if (!epochs) {
    epochs = new WeakMap<object, number>();
    sessionEpochs.set(client, epochs);
    const tracked = epochs;
    client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "setState" &&
        event.action.state === event.query.resetState
      ) {
        tracked.set(event.query, (tracked.get(event.query) ?? 0) + 1);
      }
    });
  }
  return epochs;
}

/** Normal navigation retains ownership; an auth reset invalidates every earlier callback. */
export function useSessionBoundary(key: QueryKey) {
  const client = useQueryClient();
  const identity = useRef(client.getQueryCache().find({ queryKey: key, exact: true }));
  const epochs = epochsFor(client);
  const snapshot = useCallback(
    () => (identity.current ? (epochs.get(identity.current) ?? 0) : -1),
    [epochs]
  );
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.query === identity.current &&
          event.type === "updated" &&
          event.action.type === "setState" &&
          event.action.state === event.query.resetState
        )
          notify();
      }),
    [client]
  );
  // This view subscription only refreshes renders. The client-lifetime observer above owns the fence.
  const epoch = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useCallback(
    () =>
      identity.current !== undefined &&
      epoch === snapshot() &&
      client.getQueryCache().find({ queryKey: key, exact: true }) === identity.current,
    [client, key, epoch, snapshot]
  );
}

/** Immediate editing state; the signed-in cache is recovery storage, never an input scheduler. */
export function useSessionDraft<T>(key: QueryKey, create: () => T) {
  const client = useQueryClient();
  const recovery = useQuery<T>({
    queryKey: key,
    queryFn: create,
    initialData: () => client.getQueryData<T>(key) ?? create(),
    enabled: false,
    gcTime: Infinity
  });
  const [data, setData] = useState<T>(() => recovery.data ?? create());
  const currentSession = useSessionBoundary(key);
  useEffect(() => {
    // Read the current cache, not the deferred observer payload: a notification may predate typing.
    if (currentSession()) {
      const cached = client.getQueryData<T>(key);
      // An equal write still leaves React work queued during rapid discrete input.
      // Do not echo each keystroke back through a passive effect.
      if (cached !== undefined && cached !== data) setData(cached);
    }
  }, [client, key, recovery.data, currentSession, data]);
  const update = useCallback(
    (change: (current: T) => T) => {
      if (!currentSession()) return;
      const current = client.getQueryData<T>(key);
      if (current === undefined) return;
      // Query structural sharing may return a different object from change(current).
      // Use that canonical snapshot so the recovery effect has nothing to echo.
      const next = client.setQueryData<T>(key, change(current))!;
      setData(next);
      return next;
    },
    [client, key, currentSession]
  );
  return { data, update, currentSession };
}
