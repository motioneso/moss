// Runs the TypeScript permission policy over the shared cases. Usage: tsx ts-decide.ts cases.json
import { readFileSync } from "node:fs";
import { classifyAcpPermission } from "../../../packages/acp/src/permissions.ts";

const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = cases.map((c: any) =>
  classifyAcpPermission(
    {
      sessionId: "s", turnId: "t", toolCallId: "c", title: "x", kind: null,
      toolName: c.tool, rawInput: c.raw,
      locations: c.locations.map((path: string) => ({ path })),
    },
    { cwd: c.cwd, home: c.home }
  )
);
console.log(JSON.stringify(out));
