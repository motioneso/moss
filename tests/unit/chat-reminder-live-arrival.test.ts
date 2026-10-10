// #3195: the API listener turns a committed delivery's id-only notification into one live
// reminder. A malformed payload is dropped, the owner re-read refuses anything but a stored
// delivered reminder in the owner's Main, and a dropped connection is reopened.

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataContextDb, DataContextRunner, OwnedPgClient } from "@moss/db";

import type { MainBackgroundMessage } from "../../packages/chat/src/live/background-message-routing.js";
import type { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  parseReminderArrival,
  readReminderArrival,
  REMINDER_ARRIVAL_CHANNEL,
  startReminderArrivalListener,
  type ReminderArrival
} from "../../packages/chat/src/reminders/live-arrival.js";

const ids: ReminderArrival = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  threadId: "00000000-0000-4000-8000-000000000002",
  messageId: "00000000-0000-4000-8000-000000000003"
};

class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  ended = false;
  connecting = false;
  hold: Promise<void> = Promise.resolve();
  constructor(private readonly failConnect = false) {
    super();
  }
  async connect() {
    this.connecting = true;
    await this.hold;
    if (this.failConnect) throw new Error("refused");
    return this;
  }
  async query(text: string) {
    this.queries.push(text);
    return { rows: [] };
  }
  async end() {
    if (this.ended) return;
    this.ended = true;
    this.emit("end");
  }
  notify(payload: string, channel = REMINDER_ARRIVAL_CHANNEL) {
    this.emit("notification", { processId: 1, channel, payload });
  }
}

function message(arrival: ReminderArrival): MainBackgroundMessage {
  return {
    actorUserId: arrival.actorUserId,
    mainThreadId: arrival.threadId,
    record: { kind: "reply", text: "Reminder", messageId: arrival.messageId, background: true }
  };
}

function start(clients: FakeClient[]) {
  const read = vi.fn(async (arrival: ReminderArrival) => message(arrival));
  const deliver = vi.fn(async () => undefined);
  const warn = vi.fn();
  let next = 0;
  const listener = startReminderArrivalListener({
    connectionString: "postgres://test",
    read,
    deliver,
    warn,
    retryMs: 1,
    createClient: () => clients[next++] as unknown as OwnedPgClient
  });
  return { listener, read, deliver, warn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseReminderArrival", () => {
  it("accepts exactly three ids", () => {
    expect(parseReminderArrival(JSON.stringify({ ...ids, text: "secret" }))).toEqual(ids);
  });

  it("drops anything that is not three ids", () => {
    for (const payload of [
      undefined,
      "not json",
      JSON.stringify({ ...ids, messageId: "nope" }),
      JSON.stringify({ actorUserId: ids.actorUserId, threadId: ids.threadId }),
      JSON.stringify([ids.actorUserId, ids.threadId, ids.messageId])
    ]) {
      expect(parseReminderArrival(payload)).toBeUndefined();
    }
  });
});

describe("readReminderArrival", () => {
  const main = { id: ids.threadId, incognito: false };
  const stored = {
    id: ids.messageId,
    owner_user_id: ids.actorUserId,
    thread_id: ids.threadId,
    role: "assistant",
    status: "stored",
    body: "Reminder: stretch",
    model_metadata: {
      origin: { version: 1, kind: "reminder", event: "delivered", reminderId: "r-1", late: false }
    }
  };
  const asOwner = {
    withDataContext: (_context: unknown, work: (db: DataContextDb) => Promise<unknown>) =>
      work({} as DataContextDb)
  } as unknown as DataContextRunner;

  function read(over: { main?: object | undefined; message?: object | undefined }) {
    const chat = {
      getMainThread: async () => ("main" in over ? over.main : main),
      getMessageById: async () => ("message" in over ? over.message : stored)
    } as unknown as ChatRepository;
    return readReminderArrival(asOwner, ids, chat);
  }

  it("accepts a stored delivered reminder in the owner's own Main", async () => {
    expect(await read({})).toEqual({
      actorUserId: ids.actorUserId,
      mainThreadId: ids.threadId,
      record: {
        kind: "reply",
        text: "Reminder: stretch",
        messageId: ids.messageId,
        background: true
      }
    });
  });

  it.each([
    ["the owner has no Main", { main: undefined }],
    ["Main is private", { main: { ...main, incognito: true } }],
    ["the payload names another thread", { main: { ...main, id: "other-main" } }],
    ["the message is missing", { message: undefined }],
    ["another owner wrote the message", { message: { ...stored, owner_user_id: "someone-else" } }],
    ["the message sits in another thread", { message: { ...stored, thread_id: "side-thread" } }],
    ["the message is the user's own", { message: { ...stored, role: "user" } }],
    ["the message is not stored yet", { message: { ...stored, status: "streaming" } }],
    ["the message is an ordinary reply", { message: { ...stored, model_metadata: {} } }],
    [
      "the message only confirms a saved reminder",
      {
        message: {
          ...stored,
          model_metadata: { origin: { ...stored.model_metadata.origin, event: "saved" } }
        }
      }
    ]
  ])("refuses when %s", async (_case, over) => {
    expect(await read(over)).toBeUndefined();
  });
});

describe("startReminderArrivalListener", () => {
  it("listens on the channel and delivers each valid notification once", async () => {
    const client = new FakeClient();
    const { listener, read, deliver } = start([client]);
    await listener.ready;
    expect(client.queries).toEqual([`LISTEN ${REMINDER_ARRIVAL_CHANNEL}`]);

    client.notify(JSON.stringify(ids));
    client.notify(JSON.stringify(ids), "another_channel");
    client.notify("garbage");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    await listener.stop();

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ids);
    expect(deliver).toHaveBeenCalledWith(message(ids));
    expect(client.ended).toBe(true);
  });

  it("does not deliver what the owner re-read refuses", async () => {
    const client = new FakeClient();
    const { listener, read, deliver } = start([client]);
    read.mockResolvedValueOnce(undefined as never);
    await listener.ready;
    client.notify(JSON.stringify(ids));
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Checked before stop, so the stopped flag cannot be what skips delivery.
    expect(deliver).not.toHaveBeenCalled();
    await listener.stop();
  });

  it("reconnects after a refused connection and after a dropped one", async () => {
    const refused = new FakeClient(true);
    const first = new FakeClient();
    const second = new FakeClient();
    const { listener, deliver, warn } = start([refused, first, second]);
    await listener.ready;
    expect(warn).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("connect"));
    await vi.waitFor(() => expect(first.queries).toHaveLength(1));

    await first.end();
    expect(warn).toHaveBeenCalledWith(undefined, expect.stringContaining("lost its connection"));
    await vi.waitFor(() => expect(second.queries).toHaveLength(1));
    second.notify(JSON.stringify(ids));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await listener.stop();
  });

  it("waits for a reconnect already under way, then closes it", async () => {
    const first = new FakeClient();
    const slow = new FakeClient();
    let open!: () => void;
    slow.hold = new Promise((resolve) => {
      open = resolve;
    });
    const { listener } = start([first, slow]);
    await listener.ready;
    await first.end();
    await vi.waitFor(() => expect(slow.connecting).toBe(true));

    let done = false;
    const stopped = listener.stop().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    open();
    await stopped;
    expect(slow.ended).toBe(true);
  });

  it("stays stopped after stop, even when the connection then drops", async () => {
    const client = new FakeClient();
    const spare = new FakeClient();
    const { listener } = start([client, spare]);
    await listener.ready;
    await listener.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spare.queries).toEqual([]);
  });
});
