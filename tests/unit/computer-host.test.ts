import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { hostJsonRequest } from "../../apps/api/src/computer/host-http.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";
import { parseHostConfig } from "../../scripts/computer-host/config.js";
import {
  binding,
  COMPUTER_IMAGE,
  FOREIGN,
  GATEWAY_IMAGE,
  hostFixture,
  isolatedConfig,
  OWNER
} from "./computer-host-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(options: Parameters<typeof hostFixture>[0] = {}) {
  const f = await hostFixture(options);
  cleanups.push(() => f.close());
  return f;
}
const request = (operation: string, expectedGeneration = 0, actorUserId = OWNER) => ({
  actorUserId,
  operation,
  expectedGeneration
});
const mutations = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls.filter((call) => call.method !== "GET");

describe("Computer fixed host control (real Unix IPC, Docker HTTP stand-in only)", () => {
  it("reports disabled honestly and never launches without admitted prerequisites", async () => {
    const f = await fixture();
    expect(await f.client.request(binding(), "status", 0)).toEqual({
      generation: 0,
      enabled: false,
      state: "disabled",
      reason: "none"
    });
    f.calls.length = 0;
    expect(await f.client.request(binding(), "enable", 0)).toEqual({
      generation: 1,
      enabled: true,
      state: "unavailable",
      reason: "prerequisite-unavailable"
    });
    expect(f.calls).toHaveLength(0);
    expect(f.containers.size).toBe(0);
    expect((await f.client.request(binding(), "status", 1)).state).toBe("unavailable");
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
  });

  it("missing accepted gateway cannot be replaced with an image tag or admit a launch", async () => {
    const f = await fixture({ admitted: true, gatewayImage: null });
    expect(((await f.raw(request("enable"))) as { reason: string }).reason).toBe(
      "prerequisite-unavailable"
    );
    expect(f.admission.assertAdmitted).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
    expect(() => parseHostConfig({ ...f.config, gatewayImage: "latest" })).toThrow();
  });

  it("foreign owner is denied before inspecting state or Docker", async () => {
    const f = await fixture({ admitted: true });
    expect(await f.raw(request("enable", 0, FOREIGN))).toMatchObject({
      generation: 0,
      reason: "owner-denied"
    });
    expect(f.calls).toHaveLength(0);
    expect(f.store.state.generation).toBe(0);
  });

  it("rejects stale generation without any Docker mutation", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    f.calls.length = 0;
    expect(await f.raw(request("disable", 0))).toMatchObject({
      generation: 1,
      reason: "stale-generation"
    });
    expect(f.calls).toHaveLength(0);
    expect(f.containers.size).toBe(2);
  });

  it("creates only pinned offline fixed resources and recreates with the same home", async () => {
    const f = await fixture({ admitted: true });
    const initial = await f.client.request(binding(), "enable", 0);
    expect(initial.state).toBe("running");
    const before = [...f.containers.keys()];
    const desktop = [...f.containers.values()].find((c) => c.Image === COMPUTER_IMAGE)!;
    const gateway = [...f.containers.values()].find((c) => c.Image === GATEWAY_IMAGE)!;
    expect(desktop.HostConfig).toMatchObject({
      NetworkMode: "none",
      Memory: 4 * 1024 ** 3,
      MemorySwap: 4 * 1024 ** 3,
      NanoCpus: 2e9,
      PidsLimit: 512,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: ["no-new-privileges"],
      Binds: [`${f.config.homeDir}:/home/desktop:rw`, `${f.config.guestSocketDir}:/socket:rw`],
      Devices: [],
      PortBindings: {}
    });
    expect(gateway.HostConfig).toMatchObject({
      NetworkMode: "none",
      Memory: 128 * 1024 ** 2,
      MemorySwap: 128 * 1024 ** 2,
      NanoCpus: 5e8,
      PidsLimit: 32,
      ReadonlyRootfs: true,
      Binds: [
        `${f.config.guestSocketDir}:/socket:ro`,
        `${f.config.gatewayDir}:/ipc:rw`,
        `${f.config.authDir}:/auth:ro`,
        `${f.config.gatewayConfigDir}:/config:ro`
      ]
    });
    const marker = join(f.config.homeDir, "retained.txt");
    await writeFile(marker, "persistent private fixture");
    expect((await f.client.request(binding(), "recreate", 1)).state).toBe("running");
    expect([...f.containers.keys()].every((id) => !before.includes(id))).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("persistent private fixture");
    expect(
      f.calls.filter((c) => c.path.startsWith("/containers/create")).map((c) => c.body)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Image: COMPUTER_IMAGE,
          HostConfig: expect.objectContaining({ Binds: desktop.HostConfig.Binds })
        })
      ])
    );
    expect((await f.client.request(binding(), "disable", 2)).state).toBe("disabled");
    expect(await readFile(marker, "utf8")).toBe("persistent private fixture");
  });

  it("stops gateway before desktop, never removes volumes, and retains home data", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    const gateway = [...f.containers.values()].find((c) => c.Image === GATEWAY_IMAGE)!;
    const desktop = [...f.containers.values()].find((c) => c.Image === COMPUTER_IMAGE)!;
    await writeFile(join(f.config.homeDir, "retained"), "same home");
    f.calls.length = 0;
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
    const stops = mutations(f).filter((c) => c.path.includes("/stop"));
    expect(stops.map((c) => c.path)).toEqual([
      `/containers/${gateway.Id}/stop?t=10`,
      `/containers/${desktop.Id}/stop?t=10`
    ]);
    expect(
      mutations(f)
        .filter((c) => c.method === "DELETE")
        .every((c) => c.path.endsWith("?force=0&v=0"))
    ).toBe(true);
    expect(await readFile(join(f.config.homeDir, "retained"), "utf8")).toBe("same home");
    expect(f.containers.size).toBe(0);
  });

  it("retains resource identity across failed generation advance and daemon restart", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    const ids = [...f.containers.keys()];
    await f.restart(); // No automatically restored admission and no automatic create/start.
    f.calls.length = 0;
    expect((await f.client.request(binding(), "enable", 1)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect(f.calls).toHaveLength(0);
    expect(f.store.state).toMatchObject({
      generation: 2,
      resources: [
        { id: ids[0], generation: 1 },
        { id: ids[1], generation: 1 }
      ]
    });
    await f.restart();
    expect((await f.client.request(binding(), "disable", 2)).state).toBe("disabled");
    expect(f.containers.size).toBe(0);
    expect(f.store.state.generation).toBe(3);
  });

  it.each(["extra-mount", "owner", "image", "generation", "name", "command", "privileged"])(
    "rejects %s drift before stopping anything",
    async (kind) => {
      const f = await fixture({ admitted: true });
      await f.client.request(binding(), "enable", 0);
      const first = [...f.containers.values()][0]!;
      switch (kind) {
        case "extra-mount":
          first.Mounts.push({ Type: "bind", Source: "/private", Destination: "/extra" });
          break;
        case "owner":
          (first.Config.Labels as Record<string, string>)["com.moss.computer.owner"] = FOREIGN;
          break;
        case "image":
          first.Image = `sha256:${"a".repeat(64)}`;
          break;
        case "generation":
          (first.Config.Labels as Record<string, string>)["com.moss.computer.generation"] = "999";
          break;
        case "name":
          first.Name = "/production";
          break;
        case "command":
          first.Config.Cmd = ["unexpected-exec"];
          break;
        case "privileged":
          first.HostConfig.Privileged = true;
          break;
      }
      f.calls.length = 0;
      expect((await f.client.request(binding(), "disable", 1)).reason).toBe("runtime-unavailable");
      expect(mutations(f)).toHaveLength(0);
      expect(f.containers.size).toBe(2);
      expect(f.store.state.resources).toHaveLength(2);
    }
  );

  it("rejects ambiguous/untracked instance inventory without mutation", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    const duplicate = structuredClone([...f.containers.values()][0]!);
    duplicate.Id = "f".repeat(64);
    f.containers.set(duplicate.Id, duplicate);
    f.calls.length = 0;
    expect((await f.client.request(binding(), "disable", 1)).reason).toBe("runtime-unavailable");
    expect(mutations(f)).toHaveLength(0);
  });

  it("partial start failure cleans only verified created resources and scrubs Docker errors", async () => {
    const f = await fixture({ admitted: true });
    f.faults.startRole = "desktop";
    const result = await f.client.request(binding(), "enable", 0);
    expect(result).toMatchObject({
      state: "unavailable",
      reason: "runtime-unavailable",
      generation: 1
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DOCKER_SECRET");
    expect(f.containers.size).toBe(0);
    expect(f.store.state.resources).toHaveLength(0);
    expect(f.admission.invalidate).toHaveBeenCalled();
  });

  it("successful start reply followed by early exit invalidates admission and cleans the surviving pair", async () => {
    const f = await fixture({ admitted: true });
    f.faults.exitRole = "desktop";
    expect(await f.client.request(binding(), "enable", 0)).toMatchObject({
      state: "unavailable",
      reason: "runtime-unavailable"
    });
    expect(f.admission.invalidate).toHaveBeenCalledTimes(1);
    expect(f.containers.size).toBe(0);
    expect(f.store.state.resources).toHaveLength(0);
  });

  it("early exit with failed cleanup attempts both resources and retains exact identities", async () => {
    const f = await fixture({ admitted: true });
    f.faults.exitRole = "desktop";
    f.faults.remove = true;
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    const resources = f.store.state.resources;
    expect(resources).toHaveLength(2);
    expect(resources.every((r) => r.id !== null && f.containers.has(r.id))).toBe(true);
    expect(f.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(
      resources.map((r) => `/containers/${r.id}?force=0&v=0`)
    );
    expect(f.admission.invalidate).toHaveBeenCalledTimes(1);
    f.faults.remove = false;
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
    expect(f.containers.size).toBe(0);
  });

  it("disable invalidates receiving admission before the first stop", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    let invalidatedBeforeStop = false;
    f.admission.invalidate.mockImplementation(() => {
      invalidatedBeforeStop = [...f.containers.values()].every((c) => c.State.Running);
    });
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
    expect(invalidatedBeforeStop).toBe(true);
    expect(f.admission.invalidate).toHaveBeenCalledTimes(1);
  });

  it("a broken invalidator prevents later launches but still permits exact disable cleanup", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    f.admission.invalidate.mockImplementation(() => {
      throw new Error("broken invalidator");
    });
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
    f.calls.length = 0;
    expect((await f.client.request(binding(), "enable", 2)).reason).toBe(
      "prerequisite-unavailable"
    );
    expect(f.calls).toHaveLength(0);
  });

  it("reconciles unknown create exactly once, without retrying create", async () => {
    const f = await fixture({ admitted: true });
    f.faults.unknownCreate = true;
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    expect(f.calls.filter((c) => c.path.startsWith("/containers/create"))).toHaveLength(1);
    expect(f.containers.size).toBe(0);
    expect(f.store.state.resources).toHaveLength(0);
  });

  it("never clears unresolved create intent or claims closure from missing container", async () => {
    const f = await fixture({ admitted: true });
    f.faults.createWithoutResult = true;
    await f.client.request(binding(), "enable", 0);
    expect(f.store.state.resources).toEqual([{ role: "gateway", generation: 1, id: null }]);
    await f.restart();
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("unavailable");
    expect(f.store.state.resources).toHaveLength(1);
    expect(f.calls.filter((c) => c.path.startsWith("/containers/create"))).toHaveLength(1);
  });

  it("rejects replaced storage root before any Docker operation", async () => {
    const f = await fixture({ admitted: true });
    const old = `${f.config.homeDir}-old`;
    await rename(f.config.homeDir, old);
    await mkdir(f.config.homeDir, { mode: 0o700 });
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    expect(f.calls).toHaveLength(0);
    expect(f.store.state.generation).toBe(0);
  });

  it("rejects concurrent work rather than queuing another mutation", async () => {
    const f = await fixture({ admitted: true });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.admission.assertAdmitted.mockImplementationOnce(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const enabling = f.client.request(binding(), "enable", 0);
    await started;
    expect(await f.raw(request("disable", 1))).toMatchObject({ generation: 1, reason: "busy" });
    release();
    expect((await enabling).state).toBe("running");
    expect(f.store.state.generation).toBe(1);
  });

  it("missing pinned image and oversized Docker replies stop before create", async () => {
    const f = await fixture({ admitted: true });
    f.faults.missingImage = true;
    expect((await f.client.request(binding(), "enable", 0)).reason).toBe("runtime-unavailable");
    expect(mutations(f)).toHaveLength(0);
    f.faults.missingImage = false;
    f.faults.imageBytes = 256 * 1024;
    expect((await f.client.request(binding(), "enable", 1)).reason).toBe("runtime-unavailable");
    expect(mutations(f)).toHaveLength(0);
  });

  it("failed removal retains identities and unavailable status until verified cleanup", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    const ids = f.store.state.resources.map((r) => r.id);
    f.faults.remove = true;
    expect(await f.client.request(binding(), "disable", 1)).toMatchObject({
      generation: 2,
      enabled: false,
      state: "unavailable",
      reason: "runtime-unavailable"
    });
    expect(f.store.state.resources.map((r) => r.id)).toEqual(ids);
    f.faults.remove = false;
    expect((await f.client.request(binding(), "disable", 2)).state).toBe("disabled");
    expect(f.containers.size).toBe(0);
  });

  it("failed graceful stop reinspects and kills only the same verified immutable ID", async () => {
    const f = await fixture({ admitted: true });
    await f.client.request(binding(), "enable", 0);
    const ids = f.store.state.resources.map((r) => r.id);
    f.faults.stop = true;
    f.calls.length = 0;
    expect((await f.client.request(binding(), "disable", 1)).state).toBe("disabled");
    const kills = mutations(f).filter((c) => c.path.includes("/kill"));
    expect(kills.map((c) => c.path)).toEqual(
      ids.map((id) => `/containers/${id}/kill?signal=SIGKILL`)
    );
    expect(f.containers.size).toBe(0);
  });

  it.each([
    { exec: "id" },
    { image: "evil" },
    { path: "/" },
    { operation: "delete" },
    { expectedGeneration: -1 },
    { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects request-derived host authority %j", async (extra) => {
    const f = await fixture({ admitted: true });
    await expect(f.raw({ ...request("enable"), ...extra })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.store.state.generation).toBe(0);
  });

  it("bounds oversized messages and refuses query strings", async () => {
    const f = await fixture();
    await expect(f.raw({ ...request("status"), payload: "x".repeat(1025) })).rejects.toThrow();
    await expect(
      hostJsonRequest({
        socketPath: f.socketPath,
        path: "/operation?ticket=forbidden",
        method: "POST",
        body: request("status"),
        limit: 1024,
        timeoutMs: 2000
      })
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("refuses competing daemon locks and preserves generation on clean restart", async () => {
    const f = await fixture();
    await expect(HostStateStore.open(f.config)).rejects.toThrow();
    await f.client.request(binding(), "enable", 0);
    await f.restart();
    expect(f.store.state.generation).toBe(1);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o660);
  });

  it("refuses symlinked private state, overlapping roots and insecure modes", async () => {
    const f = await isolatedConfig();
    cleanups.push(f.close);
    const store = await HostStateStore.open(f.config);
    await store.close();
    const state = join(f.config.stateDir, "state.json");
    const copy = join(f.config.stateDir, "copy.json");
    await rename(state, copy);
    await symlink(copy, state);
    await expect(HostStateStore.open(f.config)).rejects.toThrow();
    await unlink(state);
    await rename(copy, state);
    await expect(
      HostStateStore.open({ ...f.config, homeDir: f.config.stateDir })
    ).rejects.toThrow();
    await chmod(f.config.stateDir, 0o777);
    await expect(HostStateStore.open(f.config)).rejects.toThrow();
    expect(() => parseHostConfig({ ...f.config, homeDir: "/data:/:rw" })).toThrow();
  });
});
