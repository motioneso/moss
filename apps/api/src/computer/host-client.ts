import type { BrowserSessionBinding, SessionBindingsService } from "@moss/auth";
import {
  parseHostResult,
  type ComputerHostOperation,
  type ComputerHostResult
} from "./host-contract.js";
import { hostJsonRequest } from "./host-http.js";

/** Private client only. Ordinary routes/Origin and active-viewer revocation remain #3619. */
export class ComputerHostClient {
  constructor(
    private readonly deps: {
      socketPath: string;
      ownerUserId: string;
      sessions: Pick<SessionBindingsService, "assertLive">;
      now: () => Date;
    }
  ) {}

  async request(
    binding: BrowserSessionBinding,
    operation: ComputerHostOperation,
    expectedGeneration: number
  ): Promise<ComputerHostResult> {
    if (binding.actorUserId !== this.deps.ownerUserId || binding.expiresAt <= this.deps.now())
      throw new Error("Computer owner session unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.deps.sessions.assertLive({
          actorUserId: binding.actorUserId,
          sessionId: binding.sessionId
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Computer owner session unavailable")), 2000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (binding.expiresAt <= this.deps.now()) throw new Error("Computer owner session unavailable");
    return parseHostResult(
      await hostJsonRequest({
        socketPath: this.deps.socketPath,
        path: "/operation",
        method: "POST",
        body: { actorUserId: binding.actorUserId, operation, expectedGeneration },
        limit: 1024,
        timeoutMs: 120_000
      })
    );
  }
}
