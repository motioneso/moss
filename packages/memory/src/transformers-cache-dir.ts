import { join } from "node:path";

/** The one field of the embedding library's env object this module touches. */
export interface TransformersCacheEnv {
  cacheDir: string;
}

/**
 * Point the embedding library's on-disk model cache at HF_HOME when the deployment sets one.
 *
 * transformers.js defaults `env.cacheDir` to a `.cache/` folder INSIDE its own package directory
 * under node_modules. In the container that directory is owned by root while the server process
 * runs as an unprivileged user, so the very first model load dies with EACCES from mkdir before it
 * ever opens a socket. #1883: that failure reaches the assistant tool gateway as a plain Error with
 * no network error code, so it cannot be classified as a dependency failure and the user gets the
 * generic message instead of a specific one.
 *
 * The container image already declares HF_HOME and mounts a writable volume there; this makes the
 * library actually use it. Deployments that do not set HF_HOME (running from source in dev, unit
 * tests) keep the library's own default, which is writable there.
 */
export function applyTransformersCacheDir(
  env: TransformersCacheEnv,
  hfHome: string | undefined = process.env.HF_HOME
): void {
  if (!hfHome) return;
  env.cacheDir = join(hfHome, "transformers");
}
