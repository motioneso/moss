import { writeFile } from "node:fs/promises";
import { provisionForUat } from "../provisioner.js";

// Human-assisted proof: use only fresh UAT volumes, never an existing provider credential.
delete process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE;
delete process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE;
const stateFile = process.env.WORKSHOP_HUMAN_STATE_FILE;
if (!stateFile || !process.env.JARVIS_IMAGE_TAG?.startsWith("workshop-human-")) {
  throw new Error("Set a task-owned state file and workshop-human image tag");
}

let stop!: () => void;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const deadline = setTimeout(stop, 2 * 60 * 60 * 1000);
try {
  const instance = await provisionForUat("solo-admin");
  try {
    await writeFile(
      stateFile,
      JSON.stringify({
        baseURL: instance.baseURL,
        projectName: instance.projectName,
        pid: process.pid,
        ready: true
      }),
      { mode: 0o600 }
    );
    console.log(`[workshop-human] Ready: ${instance.baseURL}; SIGTERM requests owned cleanup`);
    await stopped;
  } finally {
    await instance.teardown();
    await writeFile(stateFile, JSON.stringify({ ready: false, cleaned: true }), { mode: 0o600 });
    console.log("[workshop-human] Owned instance removed");
  }
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
