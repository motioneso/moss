// Disclosed OS/transport projection. Production CJS, child collector, policy and journal run intact.
import type * as cp from "node:child_process";
import type * as nativeFs from "node:fs";
import type * as http from "node:http";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareNativeCapture } from "./computer-capture-native-fixture.js";

export async function prepareNativeBootstrap(
  configPath: string,
  held: string,
  wrapper: string,
  collector = false
) {
  await prepareNativeCapture(configPath, held);
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const fixture = JSON.parse(
    await fs.readFile(join(dirname(configPath), "capture-os.json"), "utf8")
  );
  const require = createRequire(configPath);
  const io = require("node:fs/promises") as typeof fs;
  const readlink = io.readlink;
  io.readlink = (async (path: Parameters<typeof fs.readlink>[0], ...args: unknown[]) =>
    /^\/proc\/\d+\/fd\/[12]$/.test(String(path))
      ? "/dev/null"
      : readlink(path, ...(args as []))) as typeof fs.readlink;
  const sync = require("node:fs") as typeof nativeFs;
  const network = require("node:http") as typeof http;
  const request = network.request;
  network.request = ((first: unknown, ...args: unknown[]) =>
    first instanceof URL
      ? request({
          socketPath: fixture.readySocket,
          path: first.pathname,
          method: "GET",
          agent: false
        })
      : Reflect.apply(request, network, [first, ...args])) as typeof http.request;
  const statfs = io.statfs;
  io.statfs = (async (...args: Parameters<typeof fs.statfs>) => {
    const result = await statfs(...args);
    // Explicit resource projection, not evidence of this host's runtime fit.
    Object.assign(result, { bsize: 4096n, bavail: 16_000_000n });
    return result;
  }) as typeof fs.statfs;
  let sampleWritten = false;
  let fileSynced = false;
  let directorySynced = false;
  const open = io.open;
  io.open = async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    const file = await open(path === "/proc/meminfo" ? fixture.meminfo : args[0], args[1], args[2]);
    if (collector && path === "/proc/meminfo" && held.startsWith("collection")) {
      sync.writeFileSync(fixture.collectionMarker, "held");
      file.read = (() => new Promise(() => {})) as typeof file.read;
    }
    if (!collector && path.endsWith("/observation.jsonl")) {
      const write = file.write.bind(file);
      file.write = (async (...values: Parameters<typeof file.write>) => {
        const result = await Reflect.apply(write, file, values);
        if (Buffer.isBuffer(values[0]) && values[0].includes(Buffer.from('"type":"sample"')))
          sampleWritten = true;
        return result;
      }) as typeof file.write;
    }
    if (!collector && (path.endsWith("/observation.jsonl") || path === config.monitor.path)) {
      const syncFile = file.sync.bind(file);
      file.sync = async () => {
        const directory = path === config.monitor.path;
        if (sampleWritten && held === (directory ? "sample-directory" : "sample-file")) {
          process.send!({ type: "held", heldAtNs: process.hrtime.bigint().toString() });
          return new Promise(() => {});
        }
        await syncFile();
        if (sampleWritten) {
          if (directory) directorySynced = true;
          else fileSynced = true;
        }
      };
    }
    return file;
  };
  if (!collector) {
    // The child transport gets identical OS projections through an executable wrapper, not a
    // healthy result. Preserve detached process, empty environment and three production pipes.
    const processes = require("node:child_process") as typeof cp;
    const spawn = processes.spawn;
    processes.spawn = ((command: string, args: string[], options: cp.SpawnOptions) => {
      if (args[1] !== "collect") throw new Error("Unexpected fixture child");
      return spawn(
        command,
        [
          "-e",
          "require(process.argv[1]).prepareNativeBootstrap(process.argv[2],process.argv[3],process.argv[1],true).then(()=>{const artifact=process.argv[4];process.argv=[process.execPath,artifact,'collect',process.argv[2]];require(artifact)})",
          wrapper,
          configPath,
          held,
          fixture.artifact
        ],
        options
      );
    }) as typeof cp.spawn;
    const timer = global.setTimeout;
    let bootstrapObserved = false;
    global.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 5000 && !bootstrapObserved) {
        bootstrapObserved = true;
        process.send!({ type: "bootstrap", timerStartedAtNs: process.hrtime.bigint().toString() });
      }
      return timer(fn, ms, ...args);
    }) as typeof setTimeout;
    const clear = global.clearTimeout;
    global.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if ((new Error().stack ?? "").includes("acknowledgeStartup"))
        process.send!({
          type: "durable",
          sampleWritten,
          fileSynced,
          directorySynced,
          atNs: process.hrtime.bigint().toString()
        });
      return clear(handle);
    }) as typeof clearTimeout;
  }
}
