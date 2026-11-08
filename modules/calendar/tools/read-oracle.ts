import { readHttpOracle } from "./http-oracle.js";
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const { actor, paths }: { actor: string; paths: string[] } = JSON.parse(input);
console.log(JSON.stringify(await readHttpOracle(actor, paths)));
