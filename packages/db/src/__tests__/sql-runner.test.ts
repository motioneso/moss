// #1632: runSqlFiles' file loop is split out as runSqlFilesWithClient so scripts/migrate.ts can
// run the bootstrap directory on the cluster-DDL lock's owner session instead of a second
// connection. The extracted loop must own no connection lifecycle of its own.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSqlFilesWithClient } from "../migrations/sql-runner.js";

class RecordingClient {
  readonly texts: string[] = [];
  constructor(private readonly failOn?: string) {}

  async query(text: string): Promise<unknown> {
    this.texts.push(text);
    if (this.failOn !== undefined && text === this.failOn) {
      throw new Error("boom");
    }
    return { rows: [] };
  }
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moss-sql-runner-"));
  await writeFile(join(directory, "0002_second.sql"), "SELECT 2;");
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;");
  await writeFile(join(directory, "notes.md"), "ignored");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("runSqlFilesWithClient", () => {
  it("runs each .sql file in sorted order in its own transaction on the given client", async () => {
    const client = new RecordingClient();

    const executed = await runSqlFilesWithClient(client, directory);

    expect(executed).toEqual(["0001_first.sql", "0002_second.sql"]);
    expect(client.texts).toEqual(["BEGIN", "SELECT 1;", "COMMIT", "BEGIN", "SELECT 2;", "COMMIT"]);
  });

  it("rolls back the failing file and rethrows without running later files", async () => {
    const client = new RecordingClient("SELECT 1;");

    await expect(runSqlFilesWithClient(client, directory)).rejects.toThrow("boom");

    expect(client.texts).toEqual(["BEGIN", "SELECT 1;", "ROLLBACK"]);
  });
});
