const repo = process.env.MOSS_REPO ?? `${process.env.HOME}/Jarv1s`;
const { installUatRealChatCodexAuth } = await import(`${repo}/tests/uat/real-chat-env.ts`);
const { buildUatComposeArgs } = await import(`${repo}/tests/uat/compose-args.ts`);
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const stack=JSON.parse(readFileSync(process.env.B3543_STACK_FILE ?? '/tmp/moss-first-reminder-proof/stack.json','utf8'));
Object.assign(process.env,{JARVIS_ENV_FILE:stack.envFile,JARVIS_IMAGE_TAG:process.env.JARVIS_IMAGE_TAG ?? 'b3543-first-reminder',JARVIS_WEB_PORT:String(new URL(stack.baseURL).port),JARVIS_DOCKER_SUBNET:stack.subnet,POSTGRES_PASSWORD:'postgres',JARVIS_CLI_RUNNER_RPC_SECRET:'uat-only-not-real'});
const auth=installUatRealChatCodexAuth(stack.projectName, process.argv[2], extra=>buildUatComposeArgs(stack.projectName,extra));
if(!auth) throw new Error('Host Codex login absent');
writeFileSync(process.env.B3543_AUTH_READY ?? '/tmp/moss-first-reminder-proof/auth-ready','ready');
try { while(!existsSync(process.env.B3543_AUTH_STOP ?? '/tmp/moss-first-reminder-proof/auth-stop')) await new Promise(r=>setTimeout(r,1000)); }
finally { await auth.cleanup(); }
