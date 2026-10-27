import type { WindowLog } from "./n3-window-handshake.js";

/** What a Compose project still owns, as plain names. */
export interface OwnedResourceNames {
  readonly containers: readonly string[];
  readonly volumes: readonly string[];
  readonly networks: readonly string[];
}

export interface TeardownSteps {
  readonly project: string;
  /** Stops the window server. Idempotent. */
  readonly stopWindows: () => Promise<WindowLog | undefined>;
  /** Closes the observer. Resolves with disposed=true only when it closed cleanly. */
  readonly closeObserver: () => Promise<{ readonly disposed: boolean } | undefined>;
  /** Removes credentials, then fixtures, then volumes and networks (the provisioner's order). */
  readonly removeStack: () => Promise<void>;
  /** Reads what the project still owns. */
  readonly listOwned: (project: string) => Promise<OwnedResourceNames>;
  /** Throws once the cleanup deadline has passed. */
  readonly beforeStep: () => void;
}

export type TeardownStep = "windows" | "observer" | "stack" | "inventory";

export interface TeardownReport {
  /** Steps that ran, in order. */
  readonly ran: readonly TeardownStep[];
  /** Count of failed steps; the run is red when this is not zero. */
  readonly errors: number;
  /** True when owned resources were deliberately or necessarily left in place. */
  readonly retained: boolean;
  readonly reasons: readonly string[];
  /** What the project still owns; undefined when it could not be read. */
  readonly left: OwnedResourceNames | undefined;
}

/**
 * Closes the run in a fixed order: window server, observer, then the stack (credentials before
 * volumes). Any doubt before the stack step keeps the stack, because removing it would destroy
 * the only evidence that can settle the doubt. A failure after the stack step is reported with
 * an inventory of what remains.
 */
export async function orderedTeardown(steps: TeardownSteps): Promise<TeardownReport> {
  const ran: TeardownStep[] = [];
  const reasons: string[] = [];
  let errors = 0;
  let retained = false;
  const fail = (reason: string) => {
    errors++;
    reasons.push(reason);
  };
  const attempt = async (step: TeardownStep, body: () => Promise<void>): Promise<boolean> => {
    ran.push(step);
    try {
      steps.beforeStep();
      await body();
      return true;
    } catch (error) {
      fail(`${step}: ${error instanceof Error ? error.message : "failed"}`);
      return false;
    }
  };

  const windowsOk = await attempt("windows", async () => {
    const log = await steps.stopWindows();
    if (log?.open) throw new Error("a window is still open");
    if (log?.failure) throw new Error("a window failed");
  });
  const observerOk = await attempt("observer", async () => {
    const closed = await steps.closeObserver();
    if (closed && !closed.disposed) throw new Error("the observer did not close cleanly");
  });
  if (windowsOk && observerOk) {
    if (!(await attempt("stack", () => steps.removeStack()))) retained = true;
  } else {
    retained = true;
    reasons.push("stack kept because the observer or a window is in doubt");
  }

  let left: OwnedResourceNames | undefined;
  if (retained) {
    ran.push("inventory");
    try {
      left = await steps.listOwned(steps.project);
    } catch {
      fail("inventory: could not read what the project still owns");
    }
  }
  return { ran, errors, retained, reasons, left };
}
