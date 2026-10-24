import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { closurePublicationFixture } from "./computer-closure-publication-fixture.js";
import * as consumer from "../../scripts/computer-closure/config.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../../scripts/computer-closure/config.js", async (original) => ({
  ...(await original<typeof consumer>())
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => closurePublicationFixture((close) => cleanups.push(close));

describe("publisher mandatory consumer boundary; fault-return projections are not installed proof", () => {
  it("executes its own actual loader and actual revalidator before success", async () => {
    const t = await fixture();
    const load = vi.spyOn(consumer, "loadClosureDeployment");
    const revalidate = vi.spyOn(consumer, "revalidateClosureDeployment");
    expect(await t.publish()).toBe(0);
    expect(load).toHaveBeenCalledExactlyOnceWith(
      join(t.request.output.path, "closure.json"),
      t.artifact
    );
    const result = await load.mock.results[0]!.value;
    expect(revalidate).toHaveBeenCalledExactlyOnceWith(result);
  });
  it.each(["hash", "dev", "ino", "bytes"] as const)(
    "rejects altered consumed %s independently of real original revalidation",
    async (field) => {
      const t = await fixture();
      const expected = Buffer.from(JSON.stringify((await t.load()).closure.configuration));
      const actualLoad = consumer.loadClosureDeployment;
      const actualRevalidate = consumer.revalidateClosureDeployment;
      let original: consumer.ClosureDeployment | undefined;
      let projected: consumer.ClosureDeployment | undefined;
      vi.spyOn(consumer, "loadClosureDeployment").mockImplementation(async (...args) => {
        original = await actualLoad(...args);
        const config = { ...original.config };
        if (field === "hash") config.hash = "0".repeat(64);
        if (field === "dev") config.dev++;
        if (field === "ino") config.ino++;
        if (field === "bytes") {
          config.bytes = Buffer.from(config.bytes);
          config.bytes[0] = config.bytes[0]! ^ 1;
        }
        projected = { ...original, config };
        return projected;
      });
      // Fault injection isolates the publisher's extra comparison from the consumer's redundant
      // original-snapshot comparison. It still executes actual validation of real retained files.
      const revalidate = vi
        .spyOn(consumer, "revalidateClosureDeployment")
        .mockImplementation(async (value) => {
          expect(value).toBe(projected);
          if (!original) throw new Error("actual original consumer required");
          await actualRevalidate(original);
        });
      expect(await t.publish()).toBe(2);
      expect(original).toBeDefined();
      expect(revalidate).not.toHaveBeenCalled();
      expect(await fs.readdir(t.request.output.path)).toEqual(["closure.json"]);
      expect(await fs.readFile(join(t.request.output.path, "closure.json"))).toEqual(expected);
    }
  );
});
