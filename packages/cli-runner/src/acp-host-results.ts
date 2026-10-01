export interface AcpSpawnResult {
  readonly cwd: string;
  readonly generation: number;
  /** The HOME handed to the agent process, or null when it names none. */
  readonly home: string | null;
  /** The spawned agent's own process id (setpriv execs into it, so it's the real process). */
  readonly pid: number | null;
  /** The slot account the agent runs as — the expected identity to check /proc/<pid>/status against. */
  readonly uid: number;
  readonly gid: number;
}

export interface AcpReadResult {
  readonly lines: readonly string[];
  readonly firstSeq: number;
  readonly nextSeq: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  /**
   * True when this reply — or an earlier one — was cut: the reply exceeded the
   * total cap, or the buffer dropped lines the reader had not seen yet.
   */
  readonly truncated: boolean;
}
