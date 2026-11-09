import base from "../../../vitest.config.js";

// Reuse the web package's runtime aliases, without the database suite setup.
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "modules/calendar/tools/grid-parity.test.ts",
      "modules/calendar/tools/month-parity.test.ts"
    ],
    // These differential tests launch real Rust processes; allow loaded development hosts.
    testTimeout: 120_000,
    setupFiles: []
  }
};
