import type { BrowserSessionBinding, SessionBindingsService } from "@moss/auth";

const viewerBrand = Symbol("Computer viewer");
const leaseBrand = Symbol("Computer agent input lease");

/** Process-local capabilities. Never serialize these as browser authentication. */
export interface ComputerViewer {
  readonly [viewerBrand]: true;
}
export interface ComputerAgentLease {
  readonly [leaseBrand]: true;
}

export class ComputerInputDenied extends Error {
  constructor() {
    super("Computer input authority is no longer available");
    this.name = "ComputerInputDenied";
  }
}

type Binding = Readonly<{ actorUserId: string; sessionId: string; expiresAt: number }>;
type Control =
  | { readonly mode: "paused" }
  | { readonly mode: "owner"; readonly viewer: ComputerViewer }
  | { readonly mode: "moss"; readonly grant: Binding };

/**
 * Local dispatch fencing only. The future transport must own its sole input writer,
 * queue fencing and key/button release; already-sent protocol bytes cannot be retracted here.
 * Deliberately not registered as a route or connected to a desktop yet.
 */
export class ComputerInputControl {
  readonly #viewers = new Map<ComputerViewer, Binding>();
  readonly #leases = new WeakMap<ComputerAgentLease, { generation: number; grant: Binding }>();
  #control: Control = { mode: "paused" };
  #generation = 0;
  #closed = false;

  constructor(
    private readonly deps: {
      readonly ownerUserId: string;
      readonly sessions: Pick<SessionBindingsService, "assertLive">;
      readonly now: () => Date;
    }
  ) {}

  snapshot(): { mode: Control["mode"]; viewerCount: number } {
    return { mode: this.#control.mode, viewerCount: this.#viewers.size };
  }

  async connect(session: BrowserSessionBinding): Promise<ComputerViewer> {
    const binding: Binding = Object.freeze({
      actorUserId: session.actorUserId,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.getTime()
    });
    this.#requireOpen();
    await this.#assertLive(binding);
    this.#requireOpen();
    const viewer = Object.freeze<ComputerViewer>({ [viewerBrand]: true });
    this.#viewers.set(viewer, binding);
    return viewer;
  }

  async takeOver(viewer: ComputerViewer): Promise<void> {
    const generation = this.#generation;
    await this.#authorizeViewer(viewer);
    this.#requireGeneration(generation);
    if (this.#control.mode === "owner") {
      if (this.#control.viewer !== viewer) throw new ComputerInputDenied();
      return;
    }
    this.#transition({ mode: "owner", viewer });
  }

  async returnToMoss(viewer: ComputerViewer): Promise<void> {
    const generation = this.#generation;
    const grant = await this.#authorizeViewer(viewer);
    this.#requireGeneration(generation);
    if (this.#control.mode === "owner" && this.#control.viewer !== viewer)
      throw new ComputerInputDenied();
    this.#transition({ mode: "moss", grant });
  }

  /** Intentional UI close only; unexpected transport loss must call disconnect instead. */
  async closeViewer(viewer: ComputerViewer): Promise<void> {
    const generation = this.#generation;
    try {
      const grant = await this.#authorizeViewer(viewer);
      this.#requireGeneration(generation);
      if (this.#control.mode === "owner" && this.#control.viewer === viewer)
        this.#transition({ mode: "moss", grant });
    } finally {
      this.disconnect(viewer);
    }
  }

  async dispatchOwner(viewer: ComputerViewer, send: () => undefined): Promise<void> {
    const generation = this.#generation;
    await this.#authorizeViewer(viewer);
    this.#requireGeneration(generation);
    if (this.#control.mode !== "owner" || this.#control.viewer !== viewer)
      throw new ComputerInputDenied();
    // No await between the final authority check and the trusted synchronous writer.
    send();
  }

  acquireAgentLease(actorUserId: string): ComputerAgentLease {
    this.#requireOpen();
    if (actorUserId !== this.deps.ownerUserId || this.#control.mode !== "moss")
      throw new ComputerInputDenied();
    const lease = Object.freeze<ComputerAgentLease>({ [leaseBrand]: true });
    this.#leases.set(lease, { generation: this.#generation, grant: this.#control.grant });
    return lease;
  }

  async dispatchAgent(lease: ComputerAgentLease, send: () => undefined): Promise<void> {
    const authority = this.#leases.get(lease);
    if (!authority) throw new ComputerInputDenied();
    this.#requireGeneration(authority.generation);
    try {
      await this.#assertLive(authority.grant);
    } catch (error) {
      // A delayed denial must never pause a newer grant or a new owner controller.
      if (this.#generation === authority.generation) this.#transition({ mode: "paused" });
      throw error;
    }
    this.#requireGeneration(authority.generation);
    if (this.#control.mode !== "moss" || this.#control.grant !== authority.grant)
      throw new ComputerInputDenied();
    send();
  }

  disconnect(viewer: ComputerViewer): void {
    this.#viewers.delete(viewer);
    if (this.#control.mode === "owner" && this.#control.viewer === viewer)
      this.#transition({ mode: "paused" });
    // An authorized task's grant survives viewer disconnect, but not session expiry/revocation.
  }

  invalidateSession(sessionId: string): void {
    for (const [viewer, binding] of this.#viewers) {
      if (binding.sessionId === sessionId) this.disconnect(viewer);
    }
    if (this.#control.mode === "moss" && this.#control.grant.sessionId === sessionId)
      this.#transition({ mode: "paused" });
  }

  close(): void {
    this.#closed = true;
    this.#viewers.clear();
    this.#transition({ mode: "paused" });
  }

  async #authorizeViewer(viewer: ComputerViewer): Promise<Binding> {
    this.#requireOpen();
    const binding = this.#viewers.get(viewer);
    if (!binding) throw new ComputerInputDenied();
    try {
      await this.#assertLive(binding);
    } catch (error) {
      this.invalidateSession(binding.sessionId);
      throw error;
    }
    this.#requireOpen();
    if (this.#viewers.get(viewer) !== binding) throw new ComputerInputDenied();
    return binding;
  }

  async #assertLive(binding: Binding): Promise<void> {
    this.#requireOpen();
    if (
      binding.actorUserId !== this.deps.ownerUserId ||
      !binding.sessionId ||
      !Number.isFinite(binding.expiresAt) ||
      binding.expiresAt <= this.deps.now().getTime()
    )
      throw new ComputerInputDenied();
    await this.deps.sessions.assertLive({
      actorUserId: binding.actorUserId,
      sessionId: binding.sessionId
    });
    if (binding.expiresAt <= this.deps.now().getTime()) throw new ComputerInputDenied();
  }

  #requireOpen(): void {
    if (this.#closed) throw new ComputerInputDenied();
  }

  #requireGeneration(generation: number): void {
    this.#requireOpen();
    if (generation !== this.#generation) throw new ComputerInputDenied();
  }

  #transition(control: Control): void {
    this.#generation += 1;
    this.#control = control;
  }
}
