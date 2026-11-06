import { lazy, type ComponentType } from "react";

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

export function lazyWithRetry<T extends ComponentType>(
  loader: () => Promise<{ readonly default: T }>
) {
  return lazy(() => loadWithRetry(loader));
}
