import { createElement, useEffect, useState, type ComponentType, type ElementType } from "react";

// A single failed fetch of a lazily loaded page file used to reject once and
// take the whole app down. Trying the load again a bounded number of times
// covers a brief hiccup. A stale page file after an update still fails every
// try, and the route error screen then offers a reload.
export async function loadWithRetry<T>(
  loader: () => Promise<T>,
  options?: { readonly attempts?: number; readonly delayMs?: number }
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 3);
  const delayMs = options?.delayMs ?? 300;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

type LoadState<T> =
  | { readonly status: "loaded"; readonly Component: T }
  | { readonly status: "failed"; readonly error: unknown };

type ServerLoad<T> = {
  status: "pending" | "failed";
  readonly promise: Promise<{ readonly default: T }>;
  error?: unknown;
};

// A page loaded with a retry, not a plain React lazy. One lazy object keeps
// its failed load for the life of the page, so a plain lazy page could never
// recover without a reload. Here a successful load is remembered, and a
// failed one is not. In the browser the load runs in an effect and its result
// lands in state, so a failure is thrown to the nearest error boundary on the
// next render. The route error screen unmounts the page while it shows, so
// Try again and coming back to a failed page both mount it fresh and load
// again. Server renders have no effects, so there the component suspends on
// the load promise instead, which is what the streaming renderer waits for.
export function lazyWithRetry<T extends ElementType>(
  loader: () => Promise<{ readonly default: T }>,
  options?: { readonly attempts?: number; readonly delayMs?: number }
): T {
  let cached: T | null = null;
  let serverLoad: ServerLoad<T> | null = null;
  function LazyPage(props: Record<string, unknown>) {
    const [state, setState] = useState<LoadState<T> | null>(
      cached === null ? null : { status: "loaded", Component: cached }
    );
    useEffect(() => {
      if (cached !== null) return;
      let live = true;
      loadWithRetry(loader, options).then(
        (loaded) => {
          cached = loaded.default;
          if (live) setState({ status: "loaded", Component: loaded.default });
        },
        (error: unknown) => {
          if (live) setState({ status: "failed", error });
        }
      );
      return () => {
        live = false;
      };
    }, []);
    if (cached !== null) {
      return createElement(cached as ComponentType<Record<string, unknown>>, props);
    }
    if (typeof window === "undefined") {
      if (serverLoad === null) {
        const track: ServerLoad<T> = {
          status: "pending",
          promise: loadWithRetry(loader, options).then(
            (loaded) => {
              cached = loaded.default;
              return loaded;
            },
            (error: unknown) => {
              track.status = "failed";
              track.error = error;
              throw error;
            }
          )
        };
        serverLoad = track;
      }
      if (serverLoad.status === "failed") {
        const { error } = serverLoad;
        serverLoad = null;
        throw error;
      }
      throw serverLoad.promise;
    }
    if (state?.status === "failed") throw state.error;
    if (state?.status !== "loaded") return createElement("p", { role: "status" }, "Loading...");
    return createElement(state.Component as ComponentType<Record<string, unknown>>, props);
  }
  return LazyPage as T;
}
