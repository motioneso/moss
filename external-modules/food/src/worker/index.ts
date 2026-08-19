// external-modules/food/src/worker/index.ts
//
// Food Phase 1 (#926, #1701): thin dispatch shell over registry.ts (finance/job-search split
// pattern) — manifest runtime.workerEntrypoint (jarvis.module.json) points at this file's build
// output, dist/worker/index.js. All handler logic lives in registry.ts and ./handlers/*, never
// here: defineModuleWorker attaches a readline on stdin at import time, so nothing that needs to
// be imported side-effect-free (e.g. by a test) belongs in this file.
import { defineModuleWorker } from "@moss/module-sdk/worker";

import { HANDLERS } from "./registry.js";

defineModuleWorker({ handlers: HANDLERS });
