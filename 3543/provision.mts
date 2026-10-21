const repo = process.env.MOSS_REPO ?? `${process.env.HOME}/Jarv1s`;
const { provisionForUat } = await import(`${repo}/tests/uat/provisioner.ts`);
import { writeFileSync, existsSync } from 'node:fs';
const stack = await provisionForUat('bare', { claimedWebPort: Number(process.env.B3543_WEB_PORT ?? 5185) });
writeFileSync(process.env.B3543_STACK_FILE ?? '/tmp/moss-first-reminder-proof/stack.json', JSON.stringify({baseURL:stack.baseURL, projectName:stack.projectName, envFile:process.env.JARVIS_ENV_FILE, subnet:process.env.JARVIS_DOCKER_SUBNET}));
try { while (!existsSync(process.env.B3543_STOP_FILE ?? '/tmp/moss-first-reminder-proof/stop')) await new Promise(r=>setTimeout(r,2000)); }
finally { await stack.teardown(); }
