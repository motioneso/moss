import base from "../../../vitest.config.js";

// Reuse the web package's runtime aliases, without the database suite setup.
export default {
  ...base,
  test: {
    ...base.test,
    include: ["modules/calendar/tools/grid-parity.test.ts"],
    setupFiles: []
  }
};
