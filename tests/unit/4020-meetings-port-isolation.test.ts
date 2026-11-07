import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../packages/meetings/src");
const FORBIDDEN = /from\s+["']@moss\/(calendar|people|memory)(\/[^"']*)?["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)
        ? [join(dir, e.name)]
        : []
  );
}

describe("meetings module isolation", () => {
  it("imports nothing from calendar, people or memory", () => {
    const offenders = sourceFiles(SRC).filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("scan catches a forbidden import", () => {
    expect(FORBIDDEN.test('import { x } from "@moss/people";')).toBe(true);
    expect(FORBIDDEN.test('import { x } from "@moss/calendar/internal";')).toBe(true);
  });
});
