import { sql, type Kysely } from "kysely";
import type pg from "pg";
import {
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";

export function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => (resolve = ready));
  return { promise, resolve };
}

export async function backendPid(db: DataContextDb): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db);
  return result.rows[0]!.pid;
}

/** Surface transaction failure rather than leaving its observation gate hanging. */
export function untilObserved<T>(signal: Promise<T>, result: Promise<unknown>): Promise<T> {
  return Promise.race([
    signal,
    result.then(() => {
      throw new Error("transaction finished before the expected observation");
    })
  ]);
}

/** Observe the two actual sessions, independent of which lock orders their work. */
export async function waitForSessionBlocker(
  bootstrap: pg.Client,
  waiter: number,
  holder: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await bootstrap.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder]
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${waiter} did not wait for session ${holder}`);
}

/** Attach rejection handling immediately, including when an observation fails first. */
export function observedTransaction<T>(
  runner: DataContextRunner,
  actorUserId: string,
  work: (db: DataContextDb) => Promise<T>
) {
  const pid = barrier<number>();
  const result = runner.withDataContext({ actorUserId }, async (db) => {
    pid.resolve(await backendPid(db));
    return work(db);
  });
  void result.catch(() => undefined);
  const observedPid = untilObserved(pid.promise, result);
  void observedPid.catch(() => undefined);
  return { pid: observedPid, result };
}

/** Real worker transactions with an observation hook before their work starts. */
export class ObservedDataContextRunner extends DataContextRunner {
  constructor(
    db: Kysely<MossDatabase>,
    private readonly observe: (db: DataContextDb) => Promise<void>,
    private readonly after: (db: DataContextDb) => Promise<void> = async () => undefined
  ) {
    super(db);
  }

  override withDataContext<T>(
    access: AccessContext,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T> {
    return super.withDataContext(access, async (db) => {
      await this.observe(db);
      const result = await work(db);
      await this.after(db);
      return result;
    });
  }
}
