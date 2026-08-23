// #1883: UAT-only. Loaded via NODE_OPTIONS=--import, only when writeUatEnvFile sees
// chatScript "1883-vault-search-dependency-failure" — never in production or any other chat
// script. Redirects the local embedding provider's model download to a closed local port so
// notes.search hits a real connection failure instead of downloading a real model.
// Port 65534, not port 1: Node's fetch/undici blocks certain low ports outright ("bad port"),
// so a real connection attempt never happens and there's no ECONNREFUSED to test against.
import { env } from "@huggingface/transformers";

env.remoteHost = "http://127.0.0.1:65534/";
