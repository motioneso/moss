import { describe, expect, it } from "vitest";

import { assertSameDatabase } from "../../scripts/postgres-container.js";

describe("assertSameDatabase (#3199)", () => {
  const confirmed = { database: "moss", systemIdentifier: "111" };

  it("accepts the same server and database", () => {
    expect(() => assertSameDatabase(confirmed, { ...confirmed }, "c")).not.toThrow();
  });

  it("rejects a container on a different Postgres server", () => {
    expect(() =>
      assertSameDatabase(confirmed, { database: "moss", systemIdentifier: "222" }, "c")
    ).toThrow(/different Postgres server/);
  });

  it("rejects a different database name", () => {
    expect(() =>
      assertSameDatabase(confirmed, { database: "other", systemIdentifier: "111" }, "c")
    ).toThrow(/Refusing to continue/);
  });
});
