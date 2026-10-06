import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

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
  const identity = useRef(client.getQueryCache().find({ queryKey: key, exact: true }));
  const [data, setData] = useState<T>(() => recovery.data ?? create());
  const currentSession = useCallback(
    () => client.getQueryCache().find({ queryKey: key, exact: true }) === identity.current,
    [client, key]
  );
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
