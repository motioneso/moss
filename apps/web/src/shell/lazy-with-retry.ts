import { createElement, useEffect, useRef, useState, type ComponentType } from "react";

import { LoadingScreen } from "../loading-screen.js";

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

// This is a small loadable page component, not React lazy. React lazy keeps a
// failed load for the life of the page, so the error screen's Try again button
// and a later visit to the same page would fail forever without a reload.
// Here the load state lives on the mounted component. The route error screen
// unmounts the page while it shows, so Try again and coming back to the page
// both mount it fresh and load again.
export function lazyWithRetry<T extends ComponentType<never>>(
  loader: () => Promise<{ readonly default: T }>,
  options?: { readonly attempts?: number; readonly delayMs?: number }
): T {
  function LazyPage(props: never) {
    const [state, setState] = useState<LoadState<T> | null>(null);
    const startedRef = useRef(false);
    useEffect(() => {
      if (startedRef.current) return;
      startedRef.current = true;
      let live = true;
      loadWithRetry(loader, options).then(
        (loaded) => {
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
    if (state?.status === "failed") throw state.error;
    if (state?.status !== "loaded") return createElement(LoadingScreen);
    return createElement(state.Component, props);
  }
  return LazyPage as T;
}
