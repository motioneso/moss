// #3195: the API listener turns a committed delivery's id-only notification into one live
// reminder. A malformed payload is dropped, and a dropped connection is reopened.

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OwnedPgClient } from "@moss/db";

import type { MainBackgroundMessage } from "../../packages/chat/src/live/background-message-routing.js";
import {
  parseReminderArrival,
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
  constructor(private readonly failConnect = false) {
    super();
  }
  async connect() {
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
    drawerThreadId: arrival.threadId,
    record: { kind: "reply", text: "Reminder", messageId: arrival.messageId, background: true }
  };
}

function start(clients: FakeClient[]) {
  const read = vi.fn(async (arrival: ReminderArrival) => message(arrival));
  const deliver = vi.fn(() => true);
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
    await listener.stop();
    expect(deliver).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(second.queries).toHaveLength(1));
    second.notify(JSON.stringify(ids));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await listener.stop();
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
