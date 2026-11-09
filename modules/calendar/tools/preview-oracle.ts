import { httpOracle } from "./http-oracle.js";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const { actor, requests }: { actor: string; requests: { method: "POST"; url: string; body?: Record<string, unknown> }[] } = JSON.parse(input);
console.log(JSON.stringify(await httpOracle(actor, requests)));
