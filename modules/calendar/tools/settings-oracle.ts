import { httpOracle } from "./http-oracle.js";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const { actor, patches }: { actor: string; patches: Record<string, unknown>[] } = JSON.parse(input);
console.log(
  JSON.stringify(
    await httpOracle(
      actor,
      patches.map((body) => ({
        method: "PATCH" as const,
        url: "/api/calendar/briefing-settings",
        body
      }))
    )
  )
);
