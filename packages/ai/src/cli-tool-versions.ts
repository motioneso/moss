import type { AiCliToolsDto } from "@moss/shared";

import type { ProviderKind } from "./cli-availability.js";
import type { CliToolsRunnerUpdate } from "./cli-tools-status.js";

/** #2689: installed command-line tool versions, as the cli-runner reports them. */
export interface CliToolVersions {
  readonly providers: Readonly<Record<ProviderKind, string | null>>;
  readonly opencode: string | null;
  /** Staged candidate and last check per provider, when the runner reports them. */
  readonly updates?: Readonly<Partial<Record<ProviderKind, CliToolsRunnerUpdate>>>;
}

/**
 * #2689: port the composition root wires to the cli-runner. Absent when the runner socket is not
 * configured, in which case the provider cards show no version.
 */
export type CliToolVersionReader = () => Promise<CliToolVersions>;

const READ_TIMEOUT_MS = 2_000;

/** Read the versions once for a request. A slow or failed runner yields `undefined`. */
export async function readCliToolVersions(
  reader: CliToolVersionReader | undefined,
  timeoutMs: number = READ_TIMEOUT_MS
): Promise<CliToolVersions | undefined> {
  if (!reader) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([reader().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function cliToolsDto(version: string | null): AiCliToolsDto {
  return version === null ? { version, state: "not_installed" } : { version, state: "current" };
}
