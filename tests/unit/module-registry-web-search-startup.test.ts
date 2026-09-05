import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the web-research composition seams so the test can prove that application startup,
// not a hand-built resolver, connects built-in search. Everything else in the module is real.
const seams = vi.hoisted(() => ({
  setModelNativeSearchResolver: vi.fn(),
  setWebSearchKeyResolver: vi.fn()
}));

vi.mock("@moss/web-research", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    setModelNativeSearchResolver: seams.setModelNativeSearchResolver,
    setWebSearchKeyResolver: seams.setWebSearchKeyResolver
  };
});

import { getBuiltInModuleRegistrations } from "../../packages/module-registry/src/index.js";

function settingsRegistration() {
  const registration = getBuiltInModuleRegistrations().find(
    (entry) => entry.manifest.id === "settings"
  );
  if (!registration) throw new Error("settings module registration missing");
  return registration;
}

function fakeBoss() {
  return {
    work: vi.fn(async () => `work-${Math.random()}`),
    schedule: vi.fn(async () => undefined),
    send: vi.fn(async () => null),
    createQueue: vi.fn(async () => undefined)
  } as never;
}

function fakeServer() {
  const noop = vi.fn();
  return {
    get: noop,
    post: noop,
    put: noop,
    patch: noop,
    delete: noop,
    route: noop,
    register: vi.fn(async () => undefined),
    addHook: noop,
    decorate: noop,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  } as never;
}

const baseDeps = {
  rootDb: {} as never,
  dataContext: { withDataContext: vi.fn() } as never,
  resolveAccessContext: vi.fn(),
  listConfiguredAuthProviders: () => [],
  listModuleManifests: () => [],
  resolveActiveModules: vi.fn(async () => []),
  boss: fakeBoss(),
  mcpServerUrl: "http://localhost/mcp"
};

describe("web search startup wiring (#2228, review 2 of PR #2280)", () => {
  beforeEach(() => {
    seams.setModelNativeSearchResolver.mockReset();
    seams.setWebSearchKeyResolver.mockReset();
  });

  it("background worker startup connects built-in search and the Brave key", async () => {
    const registration = settingsRegistration();
    await registration.registerWorkers!(fakeBoss(), {
      rootDb: {} as never,
      dataContext: { withDataContext: vi.fn() } as never
    });

    expect(seams.setModelNativeSearchResolver).toHaveBeenCalledTimes(1);
    expect(seams.setModelNativeSearchResolver.mock.calls[0]![0]).toBeTypeOf("function");
    expect(seams.setWebSearchKeyResolver).toHaveBeenCalledTimes(1);
    expect(seams.setWebSearchKeyResolver.mock.calls[0]![0]).toBeTypeOf("function");
  });

  it("web server startup connects built-in search and the Brave key", async () => {
    const registration = settingsRegistration();
    await registration.registerRoutes!(fakeServer(), baseDeps as never);

    expect(seams.setModelNativeSearchResolver).toHaveBeenCalledTimes(1);
    expect(seams.setModelNativeSearchResolver.mock.calls[0]![0]).toBeTypeOf("function");
    expect(seams.setWebSearchKeyResolver).toHaveBeenCalledTimes(1);
    expect(seams.setWebSearchKeyResolver.mock.calls[0]![0]).toBeTypeOf("function");
  });
});
