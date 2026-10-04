import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const specs = [
  "1909-sports-public-source-completion.uat.spec.ts",
  "notes-default-retrieval.uat.spec.ts",
  "notes-path-recheck.uat.spec.ts",
  "workshop-chat-handover.uat.spec.ts"
];

describe("owner-run Meetings real-provider gate selection", () => {
  it("selects exactly four required specs without changing credential or database authorization", async () => {
    const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    const command: string = pkg.scripts["test:uat:2981-real-providers"];
    expect(command.split(" ")).toEqual([
      "MOSS_UAT_CAPTURE_OFF=1",
      "tsx",
      "tests/uat/run-uat.ts",
      ...specs
    ]);
    expect(command).not.toMatch(/ALLOW_DIRECT_DB|GATE_RUN|REAL_CHAT_CONFIGURED|AUTH_FILE/);
  });

  it.each(specs)("keeps %s real-provider gated with no direct screenshot capture", async (name) => {
    const source = await readFile(new URL(`tests/uat/specs/${name}`, root), "utf8");
    expect(source).toMatch(/test\.skip\(\s*!REAL_CHAT_CONFIGURED/);
    expect(source).not.toMatch(/\bpage\.screenshot\(/);
  });
});
