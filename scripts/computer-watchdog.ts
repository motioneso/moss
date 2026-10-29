import { runWatchdog } from "./computer-watchdog/main.js";

void runWatchdog(process.argv).then((code) => process.exit(code));
