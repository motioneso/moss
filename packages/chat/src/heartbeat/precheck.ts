import type { HeartbeatSource, HeartbeatSourceRead } from "@moss/shared";

export interface HeartbeatCheckpoint {
  readonly revision: string;
  readonly nextBoundaryAt: Date | null;
}

/**
 * Sources worth evaluating: no saved checkpoint, a different revision, or a saved boundary that
 * has now passed. Anything else is unchanged and needs no model call.
 */
export function changedSources(
  reads: readonly HeartbeatSourceRead[],
  checkpoints: ReadonlyMap<HeartbeatSource, HeartbeatCheckpoint>,
  now: Date
): readonly HeartbeatSource[] {
  return reads
    .filter((read) => {
      const saved = checkpoints.get(read.source);
      if (!saved) return true;
      if (saved.revision !== read.revision) return true;
      return saved.nextBoundaryAt !== null && saved.nextBoundaryAt.getTime() <= now.getTime();
    })
    .map((read) => read.source);
}
