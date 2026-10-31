import type { ExternalModuleToolsHandleV1 } from "@moss/module-web-sdk";

// The host handle refuses a call while another is in flight. Finance chains its calls so each
// one starts after the previous one settles, including a remount that repeats a call on open.
export function serialTools(handle: ExternalModuleToolsHandleV1): ExternalModuleToolsHandleV1 {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    invoke(name, input) {
      const run = tail.then(() => handle.invoke(name, input));
      tail = run.catch(() => undefined);
      return run;
    }
  };
}
