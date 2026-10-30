import { useEffect, useRef, useState } from "@moss/module-web-sdk";
/** Respect the server wait without scheduling another request or retrying a write. */
export function useReadCooldown() {
  const [cooling, setCooling] = useState(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
  return {
    cooling,
    wait: (seconds: number) => {
      if (timer.current !== null) clearTimeout(timer.current);
      setCooling(true);
      timer.current = setTimeout(() => {
        setCooling(false);
        timer.current = null;
      }, seconds * 1000);
    }
  };
}
