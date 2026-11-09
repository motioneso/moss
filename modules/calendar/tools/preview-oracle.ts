import { httpOracle } from "./http-oracle.js";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const {
  actor,
  requests,
  tasks
}: {
  actor: string;
  requests: { method: "POST"; url: string; body?: Record<string, unknown> }[];
  tasks?: Record<string, { ownerUserId: string; status: string; dueAt: string | null }>;
} = JSON.parse(input);
console.log(JSON.stringify(await httpOracle(actor, requests, tasks)));
