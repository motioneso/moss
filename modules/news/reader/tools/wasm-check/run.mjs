// Loads the WebAssembly parity module and prints its report. Exit code 1 on any difference.
// Usage: node run.mjs <path to moss_news_reader_wasm_check.wasm>
import { readFileSync } from "node:fs";

const wasm = readFileSync(process.argv[2]);
const { instance } = await WebAssembly.instantiate(wasm, {});
const { run, report_ptr, report_len, memory } = instance.exports;
const differ = run();
const text = new TextDecoder().decode(new Uint8Array(memory.buffer, report_ptr(), report_len()));
process.stdout.write(text);
process.exit(differ === 0 ? 0 : 1);
