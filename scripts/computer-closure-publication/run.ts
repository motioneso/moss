import { loadClosureDeployment, revalidateClosureDeployment } from "../computer-closure/config.js";
import { assertEmptyOutput, ProvisionPublication } from "../computer-provision/publication.js";
import { computerMonotonicMs } from "../computer-watchdog/linux.js";
import { supervisorError } from "../computer-watchdog/trust.js";
import { revalidateClosurePublication, type ClosurePublicationDeployment } from "./config.js";

export const PUBLICATION_DEADLINE_MS = 60_000;

/** One clock spans initial I/O, publication and the actual native completion continuation. */
export class PublicationClock {
  private last: number;
  constructor(
    readonly startedAtMs: number,
    private readonly interrupted: () => boolean,
    private readonly now: () => number = computerMonotonicMs
  ) {
    this.last = startedAtMs;
  }
  check = (): void => {
    const at = this.now();
    if (
      !Number.isSafeInteger(this.startedAtMs) ||
      this.startedAtMs < 0 ||
      !Number.isSafeInteger(at) ||
      at < this.last ||
      at - this.startedAtMs >= PUBLICATION_DEADLINE_MS ||
      this.interrupted()
    )
      throw supervisorError();
    this.last = at;
  };
}

/** Staged private delivery only; never observes absence or grants runtime approval. */
export async function publishClosureConfiguration(
  deployment: ClosurePublicationDeployment,
  clock: PublicationClock
): Promise<0 | 2> {
  try {
    const publications: ProvisionPublication[] = [];
    const check = async () => {
      clock.check();
      await revalidateClosurePublication(deployment);
      for (const publication of publications) await publication.assertPublished();
      clock.check();
    };
    await check();
    await assertEmptyOutput(deployment.request.output);
    await check();
    const publication = await ProvisionPublication.create(
      deployment.request.output,
      "closure.json",
      deployment.closure.configuration,
      0o600,
      deployment.request.output.gid,
      check,
      clock.check
    );
    publications.push(publication);
    await check();
    const consumed = await loadClosureDeployment(
      deployment.configPath,
      deployment.request.closureArtifactPath
    );
    clock.check();
    if (
      consumed.config.hash !== publication.hash ||
      consumed.config.dev !== publication.dev ||
      consumed.config.ino !== publication.ino ||
      !consumed.config.bytes.equals(publication.bytes)
    )
      throw supervisorError();
    await revalidateClosureDeployment(consumed);
    await check();
    clock.check();
    return 0;
  } catch {
    // Preserve partial output and all inputs; a retry refuses a nonempty destination.
    return 2;
  }
}
