import { once } from "node:events";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { duplexPair } from "node:stream";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
import { RfbClient, RfbServerConnection } from "rfb2";
import { serveComputerGateway } from "../../apps/api/src/computer/gateway-server.js";
import { connectComputerGatewayViewer } from "../../apps/api/src/computer/gateway-client.js";
import { authFixture, binding, OWNER } from "./computer-auth-fixture.js";
import { WIDTH, HEIGHT, pixels } from "./computer-gateway-fixture.js";
import { fencePacket } from "./computer-rfb-fixture.js";

export async function processFixture(executable: boolean | string = false) {
  const auth = await authFixture();
  const guestSocketPath = join(auth.root, "guest.sock");
  const socketPath = join(auth.root, "gateway.sock");
  const server = createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 65_536 });
  const guests = new Set<WebSocket>();
  let connections = 0;
  let hold = false;
  let held: (() => void)[] = [];
  const events: unknown[][] = [];
  wss.on("connection", (ws) => {
    connections++;
    guests.add(ws);
    ws.on("error", () => {});
    const [transport, guestStream] = duplexPair();
    transport.on("error", () => {});
    ws.once("close", () => {
      guests.delete(ws);
      transport.destroy();
      guest.destroy();
    });
    transport.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    });
    const guest = new RfbServerConnection(guestStream, { width: WIDTH, height: HEIGHT });
    guest.on("error", () => {});
    guest.once("ready", () => guest.write(fencePacket(0, Buffer.alloc(0))));
    guest.on("updateRequest", () =>
      guest.sendUpdate([{ type: "pixels", x: 0, y: 0, width: WIDTH, height: HEIGHT, data: pixels }])
    );
    guest.on("key", (e) => events.push(["key", e.keysym, e.down]));
    guest.on("pointer", (e) => events.push(["pointer", e.x, e.y, e.buttons]));
    ws.on("message", (data) => {
      if (!Buffer.isBuffer(data)) return;
      if (data[0] === 248) {
        const reply = () => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(fencePacket(1, Buffer.from(data.subarray(9))));
        };
        if (hold) held.push(reply);
        else setImmediate(reply);
      } else transport.write(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(guestSocketPath, resolve));
  const config = {
    ownerUserId: OWNER,
    guestSocketPath,
    authSocketPath: auth.socketPath,
    socketPath
  };
  let closeService: () => Promise<void>;
  let childExit: Promise<number | null> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let childOutput = "";
  if (executable) {
    const configPath = join(auth.root, "config.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    child = spawn(
      process.execPath,
      typeof executable === "string"
        ? [executable, configPath]
        : ["--import", "tsx", "scripts/computer-gateway.ts", configPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: typeof executable === "string" ? dirname(executable) : undefined
      }
    );
    childExit = new Promise((resolve) => child!.once("exit", resolve));
    const output = (chunk: Buffer) => {
      childOutput = (childOutput + chunk.toString()).slice(-4096);
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    closeService = async () => {
      if (child!.exitCode === null && child!.signalCode === null) child!.kill("SIGTERM");
      const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
      try {
        await childExit;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          if (childOutput.includes("Computer gateway listening\n")) {
            cleanup();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Gateway executable did not become listening"));
        }, 5000);
        function cleanup() {
          clearTimeout(timer);
          child!.stdout?.off("data", ready);
        }
        child!.stdout?.on("data", ready);
        ready();
        void childExit!.then(() => {
          cleanup();
          reject(new Error("Gateway executable exited: " + childOutput));
        });
      });
    } catch (error) {
      await closeService();
      await auth.close();
      wss.close();
      server.close();
      throw error;
    }
  } else {
    const service = await serveComputerGateway(config);
    closeService = () => service.close();
  }
  const viewers: Awaited<ReturnType<typeof connectComputerGatewayViewer>>[] = [];
  const clients: RfbClient[] = [];
  return {
    auth,
    config,
    events,
    get connections() {
      return connections;
    },
    get childOutput() {
      return childOutput;
    },
    holdFences() {
      hold = true;
    },
    releaseFences() {
      hold = false;
      const replies = held;
      held = [];
      for (const reply of replies) reply();
    },
    async open(b = binding()) {
      const viewerId = auth.server.issue(b);
      const viewer = await connectComputerGatewayViewer({ socketPath, viewerId });
      viewers.push(viewer);
      return { viewerId, viewer };
    },
    async rfb(
      viewer: Awaited<ReturnType<typeof connectComputerGatewayViewer>>,
      controller = false
    ) {
      const stream = await (controller ? viewer.controller() : viewer.watch());
      const client = new RfbClient({
        stream,
        encodings: [0],
        pixelFormat: "rgbx",
        initialUpdate: false,
        autoUpdate: false
      });
      clients.push(client);
      client.on("error", () => {});
      stream.resume();
      await once(client, "connect");
      return client;
    },
    async stop() {
      await closeService();
      return childExit;
    },
    async close() {
      for (const client of clients) client.destroy();
      for (const viewer of viewers) viewer.disconnect();
      await closeService();
      for (const ws of guests) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await auth.close();
    }
  };
}
