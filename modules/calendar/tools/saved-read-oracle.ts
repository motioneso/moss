import { httpOracle, type ReferenceTask, type ReferenceRun } from "./http-oracle.js";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const {
  actor,
  requests,
  tasks,
  runs
}: {
  actor: string;
  requests: { method: "GET"; url: string }[];
  tasks: Record<string, ReferenceTask>;
  runs: Record<string, ReferenceRun>;
} = JSON.parse(input);
console.log(JSON.stringify(await httpOracle(actor, requests, tasks, runs)));
