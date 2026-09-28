import { spawnSync } from "node:child_process";

import { buildResidentLaunch } from "./start-jarv1s.js";

// Runs the real launcher's api command line and checks the resulting process
// still holds the shared sports socket group. Must start as root, like the
// launcher does.
const SHARED_GROUP_ID = 1001;
const launch = buildResidentLaunch(
  {
    role: "api",
    command: [
      "node",
      "-e",
      "const fs=require('node:fs');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),caps:/CapEff:\\s*(\\w+)/.exec(fs.readFileSync('/proc/self/status','utf8'))[1]}))"
    ],
    env: process.env
  },
  1000,
  1000,
  (process.getgroups?.() ?? []).filter((group) => group !== 0)
);
const result = spawnSync(launch.command, launch.args, { encoding: "utf8", ...launch.options });
if (result.status !== 0) throw new Error(`launcher api probe failed: ${result.stderr}`);
const probe = JSON.parse(result.stdout) as {
  uid: number;
  gid: number;
  groups: number[];
  caps: string;
};
const { groups } = probe;
if (probe.uid !== 1000 || probe.gid !== 1000) {
  throw new Error(`api process runs as ${probe.uid}:${probe.gid}, expected 1000:1000`);
}
if (!/^0+$/.test(probe.caps)) throw new Error(`api process kept capabilities ${probe.caps}`);
if (!groups.includes(SHARED_GROUP_ID)) {
  throw new Error(`api process is missing shared group ${SHARED_GROUP_ID}; has ${groups}`);
}
console.log(`launcher api process groups: ${groups.join(",")}`);
