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
    if (currentSession()) setData(client.getQueryData<T>(key)!);
  }, [client, key, recovery.data, currentSession]);
  const update = useCallback(
    (change: (current: T) => T) => {
      if (!currentSession()) return;
      const current = client.getQueryData<T>(key);
      if (current === undefined) return;
      const next = change(current);
      setData(next);
      client.setQueryData<T>(key, next);
      return next;
    },
    [client, key, currentSession]
  );
  return { data, update, currentSession };
}
