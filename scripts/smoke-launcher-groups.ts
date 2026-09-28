import { spawnSync } from "node:child_process";

import { buildResidentLaunch } from "./start-jarv1s.js";

// Runs the real launcher's api command line and checks the resulting process
// still holds the shared sports socket group. Must start as root, like the
// launcher does.
const SHARED_GROUP_ID = 1001;
const launch = buildResidentLaunch(
  {
    role: "api",
    command: ["node", "-e", "console.log(JSON.stringify(process.getgroups()))"],
    env: process.env
  },
  1000,
  1000,
  (process.getgroups?.() ?? []).filter((group) => group !== 0)
);
const result = spawnSync(launch.command, launch.args, { encoding: "utf8", ...launch.options });
if (result.status !== 0) throw new Error(`launcher api probe failed: ${result.stderr}`);
const groups = JSON.parse(result.stdout) as number[];
if (!groups.includes(SHARED_GROUP_ID)) {
  throw new Error(`api process is missing shared group ${SHARED_GROUP_ID}; has ${groups}`);
}
console.log(`launcher api process groups: ${groups.join(",")}`);
