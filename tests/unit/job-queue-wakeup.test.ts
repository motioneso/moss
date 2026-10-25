import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedPgClient } from "@moss/db";
import { JOB_QUEUE_WAKEUP_CHANNEL, startJobQueueWakeup } from "@moss/jobs";

class Client extends EventEmitter {
  readonly connect = vi.fn(async () => this);
  readonly query = vi.fn(async (_query: string) => ({ rows: [] }));
  readonly end = vi.fn(async () => {
    this.emit("end");
  });
}

function fixture(clients: Client[]) {
  const notifyWorker = vi.fn();
  let next = 0;
  const listener = startJobQueueWakeup("unused", "test.queue", { notifyWorker }, ["worker"], {
    retryMs: 50,
    createClient: () => clients[next++] as unknown as OwnedPgClient
  });
  return { listener, notifyWorker };
}

afterEach(() => vi.useRealTimers());

describe("queue wakeup lifecycle", () => {
  it("wakes only the subscribed queue and ignores notifications after stop", async () => {
    const client = new Client();
    const { listener, notifyWorker } = fixture([client]);
    await listener.ready;
    // One recovery fetch covers work committed before LISTEN became active.
    expect(notifyWorker).toHaveBeenCalledExactlyOnceWith("worker");
    notifyWorker.mockClear();
    client.emit("notification", { channel: JOB_QUEUE_WAKEUP_CHANNEL, payload: "other.queue" });
    client.emit("notification", { channel: "other", payload: "test.queue" });
    expect(notifyWorker).not.toHaveBeenCalled();
    client.emit("notification", { channel: JOB_QUEUE_WAKEUP_CHANNEL, payload: "test.queue" });
    expect(notifyWorker).toHaveBeenCalledExactlyOnceWith("worker");
    await listener.stop();
    client.emit("notification", { channel: JOB_QUEUE_WAKEUP_CHANNEL, payload: "test.queue" });
    expect(notifyWorker).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a lost connection and cancels retries on shutdown", async () => {
    vi.useFakeTimers();
    const first = new Client(),
      second = new Client();
    const { listener, notifyWorker } = fixture([first, second]);
    await listener.ready;
    first.emit("error", new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(50);
    expect(second.query).toHaveBeenCalledWith(`LISTEN ${JOB_QUEUE_WAKEUP_CHANNEL}`);
    second.emit("notification", { channel: JOB_QUEUE_WAKEUP_CHANNEL, payload: "test.queue" });
    expect(notifyWorker).toHaveBeenCalledWith("worker");
    second.emit("end");
    await listener.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(second.connect).toHaveBeenCalledTimes(1);
  });

  it("does not prevent startup when listening fails; polling can continue", async () => {
    vi.useFakeTimers();
    const first = new Client(),
      second = new Client();
    first.connect.mockRejectedValueOnce(new Error("unavailable"));
    const { listener } = fixture([first, second]);
    await listener.ready;
    await vi.advanceTimersByTimeAsync(50);
    expect(second.query).toHaveBeenCalledWith(`LISTEN ${JOB_QUEUE_WAKEUP_CHANNEL}`);
    await listener.stop();
  });

  it("closes a connection that finishes opening during shutdown without waking work", async () => {
    const client = new Client();
    let release: (client: Client) => void = () => {};
    client.connect.mockReturnValueOnce(
      new Promise<Client>((resolve) => {
        release = resolve;
      })
    );
    const { listener, notifyWorker } = fixture([client]);
    const stopping = listener.stop();
    expect(client.end).not.toHaveBeenCalled();
    release(client);
    await stopping;
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(notifyWorker).not.toHaveBeenCalled();
  });

  it("continues reconnecting after a reconnect attempt fails", async () => {
    vi.useFakeTimers();
    const first = new Client(),
      failed = new Client(),
      recovered = new Client();
    failed.connect.mockRejectedValueOnce(new Error("still unavailable"));
    const { listener, notifyWorker } = fixture([first, failed, recovered]);
    await listener.ready;
    notifyWorker.mockClear();
    first.emit("error", new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(100);
    expect(failed.end).toHaveBeenCalledTimes(1);
    expect(recovered.query).toHaveBeenCalledWith(`LISTEN ${JOB_QUEUE_WAKEUP_CHANNEL}`);
    expect(notifyWorker).toHaveBeenCalledExactlyOnceWith("worker");
    await listener.stop();
  });
});
