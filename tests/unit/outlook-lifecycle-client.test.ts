import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OutlookLifecycleClient,
  OutlookRuntimeUnavailable
} from "../../packages/connectors/src/outlook-lifecycle-client.js";

const ref = { runtimeId: "11111111-2222-3333-4444-555555555555", generation: 3 };
const unavailable = new OutlookRuntimeUnavailable();

describe.skipIf(process.platform !== "linux")("Outlook private lifecycle client", () => {
  let directory: string;
  let path: string;
  let server: Server | undefined;
  const peers = new Set<Socket>();
  const cleanups: (() => Promise<void>)[] = [];
  const config = () => ({
    socketPath: path,
    brokerUid: process.getuid!(),
    socketGid: process.getgid!()
  });
  const client = (timeoutMs = 1000) => new OutlookLifecycleClient({ ...config(), timeoutMs });

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/moss-outlook-client-");
    await chmod(directory, 0o750);
    path = join(directory, "broker.sock");
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const peer of peers) peer.destroy();
    peers.clear();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve()))
      );
      server = undefined;
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function listen(reply: (peer: Socket, data: Buffer) => void) {
    server = createServer((peer) => {
      peers.add(peer);
      peer.on("error", () => undefined);
      peer.on("data", (data: Buffer) => reply(peer, data));
      peer.once("close", () => peers.delete(peer));
    });
    server.listen(path);
    await once(server, "listening");
    await chmod(path, 0o660);
  }

  it("sends fixed references and accepts a fragmented positive acknowledgment only at EOF", async () => {
    const requests: unknown[] = [];
    await listen((peer, data) => {
      requests.push(JSON.parse(data.toString()));
      peer.write('{"ok":');
      setImmediate(() => peer.end("true}\n"));
    });
    const runtime = client();
    const extended = { ...ref, operation: "arbitrary", url: "https://invented.example.test/" };
    const allocating = runtime.allocate(extended);
    extended.generation = 9;
    await allocating;
    await runtime.remove(ref);
    expect(requests).toEqual([
      { operation: "allocate", ...ref },
      { operation: "remove", ...ref }
    ]);
  });

  it.each([
    '{"ok":false}\n',
    '{"ok":true}',
    '{"ok":true,"extra":1}\n',
    "private error\n",
    "null\n",
    ""
  ])("does not acknowledge malformed or failed completion: %j", async (response) => {
    await listen((peer) => peer.end(response));
    await expect(client().remove(ref)).rejects.toEqual(unavailable);
  });

  it("does not acknowledge success followed by late extra data", async () => {
    await listen((peer) => {
      peer.write('{"ok":true}\n');
      setTimeout(() => peer.end("extra"), 20);
    });
    await expect(client().remove(ref)).rejects.toEqual(unavailable);
  });

  it("bounds response bytes before EOF", async () => {
    await listen((peer) => peer.write("x".repeat(4096)));
    const outcome = await Promise.race([
      client()
        .remove(ref)
        .then(
          () => "accepted",
          () => "unavailable"
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve("test deadline"), 600))
    ]);
    expect(outcome).toBe("unavailable");
  });

  it("enforces an absolute deadline even while a peer sends data", async () => {
    await listen((peer) => {
      const interval = setInterval(() => peer.write(" "), 25);
      peer.once("close", () => clearInterval(interval));
    });
    const outcome = await Promise.race([
      client(80)
        .remove(ref)
        .then(
          () => "accepted",
          () => "unavailable"
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve("test deadline"), 600))
    ]);
    expect(outcome).toBe("unavailable");
  });

  it.each(["folder-mode", "socket-mode", "uid", "gid", "symlink"])(
    "rejects unsupported socket permissions/identity: %s",
    async (change) => {
      await listen((peer) => peer.end('{"ok":true}\n'));
      const settings = config();
      if (change === "folder-mode") await chmod(directory, 0o770);
      if (change === "socket-mode") await chmod(path, 0o666);
      if (change === "uid") settings.brokerUid++;
      if (change === "gid") settings.socketGid++;
      if (change === "symlink") {
        const alias = join(directory, "alias.sock");
        await symlink(path, alias);
        settings.socketPath = alias;
      }
      await expect(new OutlookLifecycleClient(settings).remove(ref)).rejects.toEqual(unavailable);
    }
  );

  it.each([
    { ...ref, runtimeId: "../other-profile" },
    { ...ref, generation: 0 },
    { ...ref, generation: 1.5 },
    { ...ref, generation: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects invalid references without sending them: %j", async (invalid) => {
    let sent = false;
    await listen((peer) => {
      sent = true;
      peer.end('{"ok":true}\n');
    });
    await expect(client().remove(invalid)).rejects.toEqual(unavailable);
    expect(sent).toBe(false);
  });

  it("reports socket absence without retaining the private path", async () => {
    await expect(client().remove(ref)).rejects.toEqual(unavailable);
  });

  it.each([false, true])("speaks to the actual Python broker (peer denied: %s)", async (denied) => {
    const processChild = spawn(
      "python3",
      [
        "-B",
        "tests/fixtures/outlook-lifecycle-broker.py",
        path,
        String(process.getuid!() + Number(denied))
      ],
      {
        env: { ...process.env, PYTHONPATH: "infra/outlook-browser" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    cleanups.push(async () => {
      if (processChild.exitCode !== null || processChild.signalCode !== null) return;
      const exited = once(processChild, "exit");
      processChild.kill("SIGTERM");
      await exited;
    });
    const [ready] = await Promise.race([
      once(processChild.stdout, "data"),
      once(processChild, "exit").then(() => {
        throw new Error("Broker fixture exited before readiness");
      })
    ]);
    expect(ready.toString()).toBe("READY\n");
    if (denied) {
      await expect(client().allocate(ref)).rejects.toEqual(unavailable);
      return;
    }
    await client().allocate(ref);
    await client().remove({ ...ref, generation: 4 });
    const operations = (await readFile(join(directory, "operations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(operations).toEqual([
      ["allocate", ref.runtimeId, 3],
      ["remove", ref.runtimeId, 4]
    ]);
  });
});
