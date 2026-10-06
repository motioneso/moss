import { afterEach, describe, expect, it, vi } from "vitest";
import type { MossAuthRuntime } from "@moss/auth";
import type * as JobsModule from "@moss/jobs";
import type { PgBoss } from "@moss/jobs";
import { createApiServer } from "../../apps/api/src/server.js";

const lifecycle = vi.hoisted(() => ({
  hooks: new Map<string, (() => Promise<void>)[]>(),
  events: [] as string[],
  producerStart: async () => {},
  consumerStart: async () => {}
}));

// Execute the real composition root's lifecycle hooks without registering routes or
// opening database/network connections. Full Fastify/real-DB startup stays in integration.
vi.mock("fastify", () => ({
  default: () => ({
    register: () => {},
    after: () => {},
    setErrorHandler: () => {},
    addHook: (name: string, hook: () => Promise<void>) => {
      const hooks = lifecycle.hooks.get(name) ?? [];
      hooks.push(hook);
      lifecycle.hooks.set(name, hooks);
    }
  })
}));
vi.mock("@moss/jobs", async (original) => ({
  ...(await original<typeof JobsModule>()),
  createPgBossClient: (connectionString: string) => {
    const role = connectionString.includes("jarvis_worker_runtime") ? "consumer" : "producer";
    return {
      send: vi.fn(),
      start: async () => {
        lifecycle.events.push(`${role}-start`);
        await (role === "producer" ? lifecycle.producerStart() : lifecycle.consumerStart());
        lifecycle.events.push(`${role}-ready`);
      },
      work: async () => {
        lifecycle.events.push("consumer-register");
      },
      offWork: async () => {
        lifecycle.events.push("consumer-drain");
      },
      stop: async () => {
        lifecycle.events.push(`${role}-stop`);
      }
    };
  }
}));
function build(boss?: Pick<PgBoss, "send">) {
  createApiServer({
    appDb: {} as never,
    workerDb: {} as never,
    authRuntime: {
      recordingCapabilities: { probeCaptureBinding: vi.fn() }
    } as unknown as MossAuthRuntime,
    ...(boss ? { boss: boss as PgBoss } : {}),
    logger: false
  });
  const ready = lifecycle.hooks.get("onReady")!.at(-1)!;
  return { ready };
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
afterEach(async () => {
  for (const name of ["preClose", "onClose"])
    for (const hook of lifecycle.hooks.get(name) ?? []) await hook();
  lifecycle.hooks.clear();
  lifecycle.events.length = 0;
  lifecycle.producerStart = async () => {};
  lifecycle.consumerStart = async () => {};
});

describe("API capture queue lifecycle ownership", () => {
  it("awaits its owned producer before starting the consumer and awaits consumer registration", async () => {
    let releaseProducer!: () => void, releaseConsumer!: () => void;
    lifecycle.producerStart = () =>
      new Promise<void>((resolve) => {
        releaseProducer = resolve;
      });
    lifecycle.consumerStart = () =>
      new Promise<void>((resolve) => {
        releaseConsumer = resolve;
      });
    const api = build();
    let ready = false;
    const pending = api.ready().then(() => {
      ready = true;
    });
    await tick();
    expect(lifecycle.events, "api-owned-producer-before-consumer").toEqual(["producer-start"]);
    expect(ready).toBe(false);
    releaseProducer();
    await tick();
    expect(lifecycle.events).toEqual(["producer-start", "producer-ready", "consumer-start"]);
    expect(ready, "api-consumer-readiness-awaited").toBe(false);
    releaseConsumer();
    await pending;
    expect(lifecycle.events).toEqual([
      "producer-start",
      "producer-ready",
      "consumer-start",
      "consumer-ready",
      "consumer-register"
    ]);
  });
  it("does not claim work if its owned producer fails to start", async () => {
    lifecycle.producerStart = async () => {
      throw new Error("producer unavailable");
    };
    const api = build();
    await expect(api.ready()).rejects.toThrow("producer unavailable");
    expect(lifecycle.events, "api-producer-failure-blocks-consumer").toEqual(["producer-start"]);
  });
  it("accepts a caller-owned send-only producer and still readies and drains its consumer", async () => {
    const producer = { send: vi.fn() };
    const api = build(producer);
    const failure = await api.ready().catch((error: unknown) => error);
    expect(failure, "api-borrowed-producer-needs-no-start").toBeUndefined();
    expect(lifecycle.events).toEqual(["consumer-start", "consumer-ready", "consumer-register"]);
    for (const hook of lifecycle.hooks.get("preClose")!) await hook();
    for (const hook of lifecycle.hooks.get("onClose")!) await hook();
    lifecycle.hooks.clear();
    expect(lifecycle.events).toEqual([
      "consumer-start",
      "consumer-ready",
      "consumer-register",
      "consumer-drain",
      "consumer-stop"
    ]);
  });
  it("propagates consumer failure instead of reporting API readiness", async () => {
    lifecycle.consumerStart = async () => {
      throw new Error("consumer unavailable");
    };
    const api = build({ send: vi.fn() });
    await expect(api.ready()).rejects.toThrow("consumer unavailable");
    expect(lifecycle.events).toEqual(["consumer-start", "consumer-stop"]);
  });
});
