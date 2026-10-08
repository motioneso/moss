/** Bound a launch and always release its deadline timer. */
export async function withLaunchTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error("launch timed out"));
        }, ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
