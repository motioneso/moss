import "./bridge.mjs";
import init from "./calendar.js";
await init({ module_or_path: new URL("./calendar_bg.wasm", import.meta.url) });
