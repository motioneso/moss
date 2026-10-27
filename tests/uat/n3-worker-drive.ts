import type { provisionForUat } from "./provisioner.js";
import type { N3ObserverOption } from "./provisioner-options.js";
import { orderedTeardown, type OwnedResourceNames, type TeardownReport } from "./n3-teardown.js";
import {
  EXPECTED_WINDOWS,
  type WindowConsumer,
  type WindowLog,
  type WindowMode,
  type WindowServer
} from "./n3-window-handshake.js";

type BuildEvidence = NonNullable<
  NonNullable<Parameters<typeof provisionForUat>[2]>["n3BuildEvidence"]
>;

export interface DriveConsumer extends WindowConsumer {
  open(): Promise<unknown>;
  close(): Promise<{ readonly disposed: boolean } | undefined>;
}

export interface DriveStack {
  readonly projectName: string;
  readonly baseURL: string;
  teardown(): Promise<void>;
}

export interface DriveInput {
  readonly evidence: string;
  readonly claimedPort: number;
  /** Epoch milliseconds when the browser run is cut off; cleanup keeps the rest. */
  readonly runEnd: number;
  readonly plan: {
    readonly option: N3ObserverOption;
    readonly runId: { readonly projectName: string; readonly suffix: string };
    readonly collector: BuildEvidence & { compose(): { readonly consumer: DriveConsumer } };
    readonly lifecycleEnv: Readonly<Record<string, string>>;
  };
  /** Worker environment. Receives the lifecycle variables; the browser child never sees them. */
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly isStopped: () => boolean;
  readonly provision: typeof provisionForUat;
  readonly serveWindows: (dir: string, consumer: DriveConsumer) => WindowServer;
  readonly verifyWindows: (log: WindowLog, expected: readonly WindowMode[]) => void;
  readonly verifyInstalled: (stack: DriveStack) => Promise<void>;
  readonly runBrowser: (env: NodeJS.ProcessEnv, deadline: number) => Promise<number>;
  readonly listOwned: (project: string) => Promise<OwnedResourceNames>;
  readonly beforeStep: () => void;
  readonly onError: (error: unknown) => void;
}

export interface DriveOutcome {
  readonly result: number;
  readonly cleanup: number;
  /** Zero only when the run passed and cleanup reported no errors. */
  readonly exitCode: number;
  readonly phase: string;
  readonly teardown: TeardownReport;
}

/**
 * The worker's join of the pieces: provision with the chosen run id, open the observer, serve
 * windows while the browser runs under the time box, check the window list, then tear down in
 * order. Every dependency is injected so the self-test can fail when any one step is removed.
 */
export async function driveWorker(input: DriveInput): Promise<DriveOutcome> {
  const { plan, env } = input;
  Object.assign(env, plan.lifecycleEnv);
  let consumer: DriveConsumer | undefined;
  let windows: WindowServer | undefined;
  let stack: DriveStack | undefined;
  let result: number;
  let phase = "provision";
  try {
    stack = await input.provision(
      "solo-admin",
      { claimedWebPort: input.claimedPort, n3Observer: plan.option },
      { n3BuildEvidence: plan.collector, runId: plan.runId }
    );
    if (input.isStopped()) throw new Error("interrupted during provisioning");
    phase = "observer-open";
    const opened = plan.collector.compose().consumer;
    consumer = opened;
    await opened.open();
    windows = input.serveWindows(input.evidence, opened);
    phase = "installed-source-correspondence";
    await input.verifyInstalled(stack);
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      JARVIS_UAT_BASE_URL: stack.baseURL,
      JARVIS_UAT_PROJECT_NAME: stack.projectName,
      MOSS_UAT_CAPTURE_OFF: "1",
      MOSS_UAT_BROWSER: "chromium"
    };
    for (const key of Object.keys(plan.lifecycleEnv)) delete childEnv[key];
    phase = "playwright";
    result = await input.runBrowser(childEnv, input.runEnd);
    if (input.isStopped()) result = 1;
    phase = result && input.now() >= input.runEnd ? "time-box" : "observer-windows";
    input.verifyWindows(await windows.stop(), EXPECTED_WINDOWS);
  } catch (error) {
    input.onError(error);
    result = 1;
  }
  const teardown = await orderedTeardown({
    project: plan.runId.projectName,
    stopWindows: async () => windows?.stop(),
    closeObserver: async () => consumer?.close(),
    removeStack: async () => stack?.teardown(),
    listOwned: input.listOwned,
    beforeStep: input.beforeStep
  });
  return {
    result,
    cleanup: teardown.errors,
    exitCode: result || teardown.errors ? 1 : 0,
    phase,
    teardown
  };
}
