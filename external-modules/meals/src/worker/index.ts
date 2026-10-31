// external-modules/meals/src/worker/index.ts
//
// Thin dispatch shell. defineModuleWorker attaches a readline on stdin at import time, so tests
// import registry.ts, never this file.
import { defineModuleWorker } from "@moss/module-sdk/worker";

import { HANDLERS } from "./registry.js";

defineModuleWorker({ handlers: HANDLERS });
