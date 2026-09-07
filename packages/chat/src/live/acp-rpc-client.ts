/**
 * ACP tunnel verbs on the runner RPC connection (#2369 slice 1).
 *
 * Lives beside `RpcConnection` rather than in it so that file stays under the
 * source-size gate. Session-scoped like the turn verbs; acpRead is a quick
 * poll (the API-side client in `@moss/acp` paces it), so the default deadline
 * applies.
 */

import { RpcConnection } from "./chat-engine-rpc-client.js";
import type {
  RpcAcpExecKillParams,
  RpcAcpExecKillResult,
  RpcAcpExecPollParams,
  RpcAcpExecPollResult,
  RpcAcpExecStartParams,
  RpcAcpExecStartResult,
  RpcAcpKillParams,
  RpcAcpKillResult,
  RpcAcpReadParams,
  RpcAcpReadResult,
  RpcAcpSendParams,
  RpcAcpSendResult,
  RpcAcpSpawnParams,
  RpcAcpSpawnResult
} from "./rpc-contract.js";

export class AcpRpcConnection extends RpcConnection {
  acpSpawn(sessionKey: string, params: RpcAcpSpawnParams): Promise<RpcAcpSpawnResult> {
    return this.call<RpcAcpSpawnResult>("acpSpawn", sessionKey, params);
  }

  acpSend(sessionKey: string, params: RpcAcpSendParams): Promise<RpcAcpSendResult> {
    return this.call<RpcAcpSendResult>("acpSend", sessionKey, params);
  }

  acpRead(sessionKey: string, params: RpcAcpReadParams): Promise<RpcAcpReadResult> {
    return this.call<RpcAcpReadResult>("acpRead", sessionKey, params);
  }

  acpKill(sessionKey: string, params: RpcAcpKillParams = {}): Promise<RpcAcpKillResult> {
    return this.call<RpcAcpKillResult>("acpKill", sessionKey, params);
  }

  // Phase 3 builds for workshop.runCommand; the API-side tunnel backing that
  // calls them landed in phase 5.
  acpExecStart(sessionKey: string, params: RpcAcpExecStartParams): Promise<RpcAcpExecStartResult> {
    return this.call<RpcAcpExecStartResult>("acpExecStart", sessionKey, params);
  }

  acpExecPoll(sessionKey: string, params: RpcAcpExecPollParams): Promise<RpcAcpExecPollResult> {
    return this.call<RpcAcpExecPollResult>("acpExecPoll", sessionKey, params);
  }

  acpExecKill(sessionKey: string, params: RpcAcpExecKillParams): Promise<RpcAcpExecKillResult> {
    return this.call<RpcAcpExecKillResult>("acpExecKill", sessionKey, params);
  }
}
