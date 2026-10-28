import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SITES = Object.freeze([
  "turn",
  "ensure.initial",
  "ensure.retry",
  "heal",
  "factory",
  "launch",
  "replay.submit",
  "submit.initial",
  "submit.retry",
  "classifier.evaluate",
  "shadow.start",
  "shadow.run"
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const ENTRY = "/app/dist/server.js";
export const IMPORT = "/app/tests/uat/n3-fallback-observer-bootstrap.mjs";
const CHANNEL = "moss.chat.attempt.v1";
const EVENT_KEYS = [
  "version",
  "sequence",
  "phase",
  "sites",
  "site",
  "attemptId",
  "actorUserId",
  "surface",
  "turnId",
  "threadId",
  "outcome",
  "aborted",
  "observerError"
];

function plain(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      keys.includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")
  );
}
function validConfig(c, now) {
  return (
    plain(c, ["nonce", "bootstrapSha256", "schema", "deadline"]) &&
    HEX.test(c.nonce) &&
    HEX.test(c.bootstrapSha256) &&
    c.schema === 1 &&
    Number.isSafeInteger(c.deadline) &&
    c.deadline > now
  );
}
function identityValid(i) {
  return (
    plain(i, ["pid", "startTicks", "bootId", "containerId"]) &&
    Number.isSafeInteger(i.pid) &&
    i.pid > 0 &&
    /^[0-9]{1,24}$/.test(i.startTicks) &&
    UUID.test(i.bootId) &&
    HEX.test(i.containerId)
  );
}

/** All entrypoints and every deferred callback terminate failures inside this boundary. */
export function activateObserver(config, io) {
  const state = {
    error: null,
    listening: false,
    sequence: 0,
    bytes: 0,
    requests: 0,
    windowNumber: 0,
    completedWindows: 0,
    barrier: null,
    window: null,
    identity: null,
    pins: null,
    stopped: false
  };
  const coverage = new Set();
  const attempts = new Map();
  const turns = new Map();
  const counts = Object.fromEntries(SITES.map((site) => [site, 0]));
  let server, timer, unsubscribe, client;
  let buffered = 0;
  const fail = (code) => {
    state.error ??= code;
  };
  const guard =
    (work) =>
    (...args) => {
      try {
        const result = work(...args);
        if (result && typeof result.then === "function")
          void Promise.resolve(result).catch(() => {
            fail("callback");
          });
        return result;
      } catch {
        fail("callback");
      }
    };
  const call = (name, ...args) =>
    guard(() => {
      const value = io[name](...args);
      if (value && typeof value.then === "function") {
        void Promise.resolve(value).catch(() => {
          fail("callback");
        });
        fail("initialization");
        return undefined;
      }
      return value;
    })();
  const check = (condition, code) => {
    if (!condition) {
      fail(code);
      return false;
    }
    return true;
  };
  const open = () => [...attempts.values()].filter((a) => !a.settled).length;
  const healthy = () => {
    if (state.error || state.stopped) return false;
    if (call("now") >= config.deadline) fail("deadline");
    if (state.identity && !call("sameIdentity", state.identity)) fail("identity");
    if (state.listening && !call("privateTransport")) fail("permissions");
    return !state.error && !state.stopped && state.listening && coverage.size === SITES.length;
  };
  const status = () => ({
    version: 1,
    identity: state.identity,
    pins: state.pins,
    ready: healthy(),
    error: state.error,
    sequence: state.sequence,
    counters: { ...counts },
    coverage: [...coverage],
    openAttempts: open(),
    attempts: attempts.size,
    metadataBytes: state.bytes,
    completedWindows: state.completedWindows
  });
  const receive = guard((event) => {
    if (state.error || state.stopped) return;
    if (!check(healthy() || (!state.error && coverage.size < SITES.length), "unavailable")) return;
    if (!check(plain(event, EVENT_KEYS), "schema")) return;
    if (
      !check(
        event.version === 1 &&
          Number.isSafeInteger(event.sequence) &&
          event.sequence === state.sequence + 1,
        "sequence"
      )
    )
      return;
    if (!check(!event.observerError, "producer")) return;
    if (!check(["coverage", "entry", "context", "settle", "error"].includes(event.phase), "schema"))
      return;
    const encoded = call("encode", event);
    if (!check(typeof encoded === "string" && Buffer.byteLength(encoded) <= 4096, "frame")) return;
    state.bytes += Buffer.byteLength(encoded);
    if (!check(state.bytes <= 65536, "metadata_limit")) return;
    state.sequence = event.sequence;
    state.barrier = null;
    if (event.phase === "error") {
      fail("producer");
      return;
    }
    if (event.phase === "coverage") {
      if (
        !check(
          Array.isArray(event.sites) &&
            event.sites.length <= SITES.length &&
            event.sites.every((s) => SITES.includes(s)) &&
            new Set(event.sites).size === event.sites.length &&
            [...coverage].every((s) => event.sites.includes(s)),
          "coverage"
        )
      )
        return;
      for (const site of event.sites) coverage.add(site);
      return;
    }
    if (
      !check(
        UUID.test(event.actorUserId) &&
          UUID.test(event.turnId) &&
          event.surface === "drawer" &&
          (event.threadId === null || UUID.test(event.threadId)),
        "correlation"
      )
    )
      return;
    if (event.phase === "entry") {
      if (
        !check(
          SITES.includes(event.site) &&
            typeof event.aborted === "boolean" &&
            event.attemptId === event.sequence &&
            !attempts.has(event.attemptId),
          "schema"
        )
      )
        return;
      if (!check(attempts.size < 256, "attempt_limit")) return;
      if (event.site === "turn") {
        if (!check(open() === 0 && !turns.has(event.turnId), "concurrency")) return;
        const window = state.window;
        if (
          window &&
          !check(
            window.begins === 0 &&
              event.actorUserId === window.actorUserId &&
              event.surface === window.surface &&
              (event.threadId === null || event.threadId === window.threadId),
            "window_correlation"
          )
        )
          return;
        turns.set(event.turnId, {
          actorUserId: event.actorUserId,
          surface: event.surface,
          threadId: event.threadId,
          settled: false
        });
        if (window) {
          window.begins++;
          window.turnId = event.turnId;
        }
      }
      const turn = turns.get(event.turnId);
      if (
        !check(
          turn &&
            turn.actorUserId === event.actorUserId &&
            turn.surface === event.surface &&
            turn.threadId === event.threadId,
          "correlation"
        )
      )
        return;
      // A descendant may start after the turn's finally only while another descendant owns it.
      if (
        !check(
          !turn.settled ||
            [...attempts.values()].some((a) => a.turnId === event.turnId && !a.settled),
          "orphan"
        )
      )
        return;
      attempts.set(event.attemptId, { site: event.site, turnId: event.turnId, settled: false });
      counts[event.site]++;
      return;
    }
    const turn = turns.get(event.turnId);
    if (
      !check(
        turn && turn.actorUserId === event.actorUserId && turn.surface === event.surface,
        "correlation"
      )
    )
      return;
    if (event.phase === "context") {
      if (
        !check(
          UUID.test(event.threadId) &&
            (!turn.threadId || turn.threadId === event.threadId) &&
            (!state.window || event.threadId === state.window.threadId),
          "thread"
        )
      )
        return;
      turn.threadId = event.threadId;
      return;
    }
    const attempt = attempts.get(event.attemptId);
    if (
      !check(
        attempt &&
          !attempt.settled &&
          attempt.site === event.site &&
          attempt.turnId === event.turnId &&
          turn.threadId === event.threadId &&
          (!state.window || turn.threadId === state.window.threadId) &&
          typeof event.aborted === "boolean" &&
          ["ok", "error", "aborted"].includes(event.outcome) &&
          (event.outcome === "aborted") === event.aborted,
        "settlement"
      )
    )
      return;
    attempt.settled = true;
    if (event.site === "turn") {
      if (!check(UUID.test(turn.threadId), "thread")) return;
      turn.settled = true;
      if (state.window) state.window.ends++;
    }
  });
  const command = (request) => {
    if (
      !check(
        plain(request, [
          "version",
          "nonce",
          "requestId",
          "op",
          "identity",
          "actorUserId",
          "threadId",
          "surface",
          "mode",
          "sequence",
          "barrier",
          "turnId",
          "complete"
        ]),
        "protocol"
      )
    )
      return status();
    if (
      !check(
        request.version === 1 &&
          request.nonce === config.nonce &&
          Number.isSafeInteger(request.requestId) &&
          request.requestId === state.requests + 1 &&
          identityValid(request.identity) &&
          Object.keys(state.identity).every((key) => request.identity[key] === state.identity[key]),
        "protocol_identity"
      )
    )
      return status();
    state.requests = request.requestId;
    if (!healthy()) return status();
    if (request.op === "status") return status();
    if (request.op === "begin") {
      if (
        !check(
          !state.window &&
            open() === 0 &&
            UUID.test(request.actorUserId) &&
            UUID.test(request.threadId) &&
            request.surface === "drawer" &&
            ["terminal", "positive"].includes(request.mode),
          "begin"
        )
      )
        return status();
      state.window = {
        actorUserId: request.actorUserId,
        threadId: request.threadId,
        surface: request.surface,
        mode: request.mode,
        begins: 0,
        ends: 0,
        start: { ...counts },
        number: ++state.windowNumber
      };
      state.barrier = null;
      return { ...status(), window: state.window.number };
    }
    if (request.op === "barrier") {
      if (
        !check(
          state.window &&
            state.window.begins === 1 &&
            state.window.ends === 1 &&
            open() === 0 &&
            request.sequence === state.sequence,
          "barrier"
        )
      )
        return status();
      const token = call("barrierToken");
      if (!check(typeof token === "string" && UUID.test(token), "barrier")) return status();
      state.barrier = { sequence: state.sequence, token };
      return { ...status(), barrier: { ...state.barrier } };
    }
    if (request.op === "end") {
      const w = state.window;
      if (
        !check(
          w &&
            w.begins === 1 &&
            w.ends === 1 &&
            open() === 0 &&
            request.complete === true &&
            request.turnId === w.turnId &&
            request.actorUserId === w.actorUserId &&
            request.threadId === w.threadId &&
            request.surface === w.surface &&
            state.barrier &&
            request.sequence === state.sequence &&
            request.barrier === state.barrier.token &&
            state.barrier.sequence === state.sequence,
          "end"
        )
      )
        return status();
      if (
        !check(
          w.mode !== "terminal" || SITES.every((s) => s === "turn" || counts[s] === w.start[s]),
          "forbidden_attempt"
        )
      )
        return status();
      const delta = Object.fromEntries(SITES.map((s) => [s, counts[s] - w.start[s]]));
      state.completedWindows++;
      state.window = null;
      state.barrier = null;
      return { ...status(), window: w.number, turnId: w.turnId, delta };
    }
    fail("protocol");
    return status();
  };
  const query = guard((request) => command(request));
  const close = guard(() => {
    state.stopped = true;
    state.listening = false;
    // Independent guarded releases: a failed unsubscribe cannot escape or skip the timer/server.
    guard(() => unsubscribe?.())();
    guard(() => call("clearTimer", timer))();
    guard(() => client?.destroy())();
    guard(() => server?.close(guard(() => {})))();
  });
  const api = { receive, query, status: guard(status), close, guard };
  guard(() => {
    if (!validConfig(config, call("now"))) {
      fail("configuration");
      return;
    }
    if (io.entry !== ENTRY) {
      state.stopped = true;
      return;
    }
    if (
      !check(
        call("realEntry") === ENTRY && call("selfHash") === config.bootstrapSha256,
        "bootstrap_pin"
      )
    )
      return;
    const identity = call("identity");
    if (!check(identityValid(identity), "identity")) return;
    state.identity = Object.freeze({ ...identity });
    const bundleSha256 = call("entryHash");
    if (!check(typeof bundleSha256 === "string" && HEX.test(bundleSha256), "bundle_pin")) return;
    state.pins = Object.freeze({ bootstrapSha256: config.bootstrapSha256, bundleSha256 });
    call("makePrivate", config.nonce);
    server = call(
      "server",
      guard((socket) => {
        if (client) {
          fail("concurrency");
          guard(() => socket.destroy())();
          return;
        }
        client = socket;
        let pending = Buffer.alloc(0);
        socket.on(
          "error",
          guard(() => {
            fail("transport");
          })
        );
        socket.on(
          "close",
          guard(() => {
            if (!state.stopped) fail("transport_loss");
          })
        );
        socket.on(
          "data",
          guard((chunk) => {
            if (state.error) return;
            if (!check(Buffer.isBuffer(chunk) && pending.length + chunk.length <= 4096, "frame"))
              return;
            buffered += chunk.length;
            if (!check(buffered <= 65536, "metadata_limit")) return;
            pending = Buffer.concat([pending, chunk]);
            let newline;
            while ((newline = pending.indexOf(10)) !== -1) {
              const frame = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              buffered -= frame.length + 1;
              const reply = command(JSON.parse(frame.toString("utf8")));
              const output = call("encode", reply);
              if (
                !check(typeof output === "string" && Buffer.byteLength(output) + 1 <= 4096, "frame")
              )
                return;
              if (
                !check(
                  socket.write(
                    output + "\n",
                    guard((error) => {
                      if (error) fail("transport");
                    })
                  ),
                  "backpressure"
                )
              )
                return;
            }
          })
        );
      })
    );
    server.on(
      "error",
      guard(() => {
        fail("transport");
      })
    );
    server.listen(
      call("socketPath", config.nonce),
      guard(() => {
        call("secureSocket");
        state.listening = true;
        if (!call("privateTransport")) fail("permissions");
      })
    );
    unsubscribe = call("subscribe", receive);
    timer = call(
      "timer",
      guard(() => {
        fail("deadline");
      }),
      Math.min(config.deadline - call("now"), 2147483647)
    );
    timer?.unref?.();
  })();
  return api;
}

function processIdentity() {
  const raw = fs.readFileSync("/proc/self/stat", "utf8");
  const startTicks = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19];
  const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8");
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
  const containerId = /(?:docker[-/]|containers\/)([a-f0-9]{64})(?:[/.\s]|$)/.exec(
    cgroup + "\n" + mounts
  )?.[1];
  return {
    pid: process.pid,
    startTicks,
    containerId,
    bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  };
}
export function runtime(entry, files = fs) {
  let directory, socket, directoryStat, socketStat;
  const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.uid === b.uid;
  return {
    entry,
    now: Date.now,
    encode: JSON.stringify,
    realEntry: () => files.realpathSync(entry),
    selfHash: () =>
      createHash("sha256")
        .update(files.readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
    identity: processIdentity,
    entryHash: () => createHash("sha256").update(files.readFileSync(entry)).digest("hex"),
    sameIdentity: (expected) => {
      const actual = processIdentity();
      return Object.keys(expected).every((key) => expected[key] === actual[key]);
    },
    makePrivate: (nonce) => {
      directory = `/run/jarv1s/n3-${nonce}`;
      socket = `${directory}/observer.sock`;
      files.mkdirSync(directory, { mode: 0o700 });
      directoryStat = files.lstatSync(directory);
    },
    socketPath: () => socket,
    secureSocket: () => {
      files.chmodSync(socket, 0o600);
      socketStat = files.lstatSync(socket);
    },
    privateTransport: () => {
      const d = files.lstatSync(directory),
        s = files.lstatSync(socket);
      return (
        sameFile(d, directoryStat) &&
        sameFile(s, socketStat) &&
        d.isDirectory() &&
        (d.mode & 0o777) === 0o700 &&
        d.uid === process.getuid() &&
        s.isSocket() &&
        (s.mode & 0o777) === 0o600 &&
        s.uid === d.uid
      );
    },
    server: createServer,
    subscribe: (receive) => {
      const diagnostics = channel(CHANNEL);
      diagnostics.subscribe(receive);
      return () => diagnostics.unsubscribe(receive);
    },
    barrierToken: randomUUID,
    timer: setTimeout,
    clearTimer: clearTimeout
  };
}

// No option means no filesystem, timers, sockets or subscriber. Other imported children are inert.
// Any setup failure leaves this diagnostic unavailable; it must never change product startup.
try {
  const nonce = process.env.MOSS_N3_OBSERVER_NONCE;
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (nonce !== undefined && entry === ENTRY) {
    activateObserver(
      {
        nonce,
        bootstrapSha256: process.env.MOSS_N3_OBSERVER_SHA256,
        schema: Number(process.env.MOSS_N3_OBSERVER_SCHEMA),
        deadline: Number(process.env.MOSS_N3_OBSERVER_DEADLINE)
      },
      runtime(entry)
    );
  }
} catch {
  /* Unavailable; no process-wide exception handler. */
}
