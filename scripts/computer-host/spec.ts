import { COMPUTER_IMAGE, type HostConfig } from "./config.js";
import type { HostResource } from "./state.js";

export function resourceName(config: HostConfig, resource: HostResource): string {
  return `moss-computer-${config.instanceId}-${resource.role}-${resource.generation}`;
}
export function resourceLabels(config: HostConfig, resource: HostResource) {
  return {
    "com.moss.computer.instance": config.instanceId,
    "com.moss.computer.owner": config.ownerUserId,
    "com.moss.computer.role": resource.role,
    "com.moss.computer.generation": String(resource.generation)
  };
}

export function resourceSpec(config: HostConfig, resource: HostResource) {
  const desktop = resource.role === "desktop";
  const image = desktop ? COMPUTER_IMAGE : config.gatewayImage;
  if (!image) throw new Error("Gateway image unavailable");
  return {
    Image: image,
    User: "1000:1000",
    Labels: resourceLabels(config, resource),
    OpenStdin: false,
    Tty: false,
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: ["no-new-privileges"],
      NanoCpus: desktop ? 2_000_000_000 : 500_000_000,
      Memory: desktop ? 4 * 1024 ** 3 : 128 * 1024 ** 2,
      MemorySwap: desktop ? 4 * 1024 ** 3 : 128 * 1024 ** 2,
      PidsLimit: desktop ? 512 : 32,
      ShmSize: desktop ? 256 * 1024 ** 2 : 1024 ** 2,
      Tmpfs: desktop
        ? {
            "/tmp": "size=256m,mode=1777",
            "/run": "size=32m,uid=1000,gid=1000,mode=0700"
          }
        : { "/tmp": "size=16m,mode=1777" },
      Binds: desktop
        ? [`${config.homeDir}:/home/desktop:rw`, `${config.guestSocketDir}:/socket:rw`]
        : [
            `${config.guestSocketDir}:/socket:ro`,
            `${config.gatewayDir}:/ipc:rw`,
            `${config.authDir}:/auth:ro`,
            `${config.gatewayConfigDir}:/config:ro`
          ],
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      LogConfig: { Type: "json-file", Config: { "max-size": "2m", "max-file": "2" } },
      PortBindings: {},
      PublishAllPorts: false,
      Devices: [],
      DeviceRequests: [],
      VolumesFrom: [],
      Links: [],
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      CgroupnsMode: "private",
      AutoRemove: false
    }
  };
}
