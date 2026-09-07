/**
 * Workshop outside-agent wiring (#2369 slice 1 phase 5).
 *
 * The API-side backing for the Workshop reply path: an `AcpTunnel` over the
 * chat runtime's runner RPC connection, a per-reply session opener that mints
 * the fixed-expiry tool-server Bearer [REDACTED] hands the agent, and the production
 * `WorkshopRunCommandService` over the acpExec verbs. Until this file existed
 * the tool stayed hidden behind the gateway's fail-closed service filter.
 */

import { MossAcpClient, type AcpPermissionDecider, type AcpTunnel } from "@moss/acp";
import { requestAcpBuiltInPermission, type AcpPermissionGatewayDeps } from "@moss/ai";
import { HttpError } from "@moss/module-sdk";
import type { WorkshopAcpOpener, WorkshopAcpTurn, WorkshopRunCommandService } from "@moss/workshop";

import type { AcpRpcConnection } from "./live/acp-rpc-client.js";

/** `AcpTunnel` over one runner RPC connection. */
export class RpcAcpTunnel implements AcpTunnel {
  constructor(private readonly connection: AcpRpcConnection) {}

  async spawn(
    sessionKey: string,
    projectId: string
  ): Promise<{ cwd: string; home: string | null }> {
    const result = await this.connection.acpSpawn(sessionKey, { projectId });
    return { cwd: result.cwd, home: result.home };
  }

  async send(sessionKey: string, line: string): Promise<void> {
    await this.connection.acpSend(sessionKey, { line });
  }

  async read(
    sessionKey: string,
    afterSeq: number
  ): Promise<{
    lines: readonly string[];
    firstSeq: number;
    nextSeq: number;
    exited: boolean;
    truncated: boolean;
  }> {
    const result = await this.connection.acpRead(sessionKey, { afterSeq });
    return {
      lines: result.lines,
      firstSeq: result.firstSeq,
      nextSeq: result.nextSeq,
      exited: result.exited,
      truncated: result.truncated
    };
  }

  async kill(sessionKey: string): Promise<void> {
    await this.connection.acpKill(sessionKey, {});
  }

  async execStart(
    sessionKey: string,
    projectId: string,
    command: string,
    timeoutMs?: number
  ): Promise<{ execId: number }> {
    const result = await this.connection.acpExecStart(sessionKey, {
      projectId,
      command,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    return { execId: result.execId };
  }

  async execPoll(
    sessionKey: string,
    execId: number
  ): Promise<{
    output: string;
    done: boolean;
    exitCode: number | null;
    truncated: boolean;
    timedOut: boolean;
  }> {
    const result = await this.connection.acpExecPoll(sessionKey, { execId });
    return {
      output: result.output,
      done: result.done,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.timedOut
    };
  }

  async execKill(sessionKey: string, execId: number): Promise<void> {
    await this.connection.acpExecKill(sessionKey, { execId });
  }
}

export interface WorkshopAcpOpenerDeps {
  /** The chat runtime's runner connection; absent on the in-process path. */
  readonly getConnection: () => AcpRpcConnection | undefined;
  readonly tokens: AcpPermissionGatewayDeps["tokens"];
  readonly mcpServerUrl: string;
  readonly listToolsForActor: (
    actorUserId: string
  ) => Promise<readonly { readonly name: string }[]>;
  readonly permissionGateway: AcpPermissionGatewayDeps;
}

/** One prompt turn against the outside agent; close revokes the Bearer [REDACTED] stops the adapter. */
export function createWorkshopAcpOpener(deps: WorkshopAcpOpenerDeps): WorkshopAcpOpener {
  return {
    async open(input): Promise<WorkshopAcpTurn> {
      const connection = deps.getConnection();
      if (!connection) {
        throw new Error("The outside agent needs the runner connection, which is not up.");
      }
      const tunnel = new RpcAcpTunnel(connection);
      const allowedToolNames = new Set(
        (await deps.listToolsForActor(input.actorUserId)).map((tool) => tool.name)
      );
      // Fixed end time: a leaked outside token goes stale on its own. Revoked
      // on close; the TTL is only the backstop.
      const bearer = deps.tokens.mint(
        {
          actorUserId: input.actorUserId,
          chatSessionId: input.sessionKey,
          allowedToolNames
        },
        { fixedExpiry: true }
      );
      const decider: AcpPermissionDecider = {
        decide: async (request, session) => {
          const rawInput = request.rawInput;
          const response = await requestAcpBuiltInPermission(deps.permissionGateway, bearer, {
            cwd: session.cwd,
            home: session.home,
            sessionId: session.sessionId,
            toolCallId: request.toolCallId,
            title: request.title,
            toolInput:
              typeof rawInput === "object" && rawInput !== null
                ? (rawInput as Record<string, unknown>)
                : {},
            toolName: request.toolName,
            kind: request.kind,
            locations: request.locations
          });
          return response.decision === "allow" ? "allow" : "deny";
        }
      };
      const client = new MossAcpClient(tunnel, {}, decider);
      let handle;
      try {
        handle = await client.openSession(input.sessionKey, input.projectId, "workshop", {
          url: deps.mcpServerUrl,
          bearer,
          onClose: () => deps.tokens.revokeBySessionId(input.sessionKey)
        });
      } catch (error) {
        // The Bearer [REDACTED] minted above or the turn never starts: revoke it
        // now rather than letting it sit valid until its fixed end time.
        deps.tokens.revokeBySessionId(input.sessionKey);
        throw error;
      }
      return {
        async prompt(text: string): Promise<string> {
          const result = await client.prompt(handle, text, {
            timeoutMs: 10 * 60 * 1000
          });
          return result.text;
        },
        async close(): Promise<void> {
          try {
            await client.close(handle);
          } finally {
            // The per-reply adapter owns a process group on the runner; take
            // it down even if the client bookkeeping already went.
            await tunnel.kill(input.sessionKey).catch(() => undefined);
          }
        }
      };
    }
  };
}

/** `workshop.runCommand` over the runner exec verbs. */
export function createWorkshopRunCommandService(
  getConnection: () => AcpRpcConnection | undefined
): WorkshopRunCommandService {
  const requireConnection = (): AcpRpcConnection => {
    const connection = getConnection();
    if (!connection) {
      throw new HttpError(
        503,
        "Running project commands needs the runner connection, which is not up."
      );
    }
    return connection;
  };
  return {
    async start(input) {
      const result = await requireConnection().acpExecStart(input.sessionKey, {
        projectId: input.projectId,
        command: input.command,
        timeoutMs: input.timeoutMs
      });
      return { execId: result.execId };
    },
    async poll(input) {
      const result = await requireConnection().acpExecPoll(input.sessionKey, {
        execId: input.execId
      });
      return {
        output: result.output,
        done: result.done,
        exitCode: result.exitCode,
        truncated: result.truncated,
        timedOut: result.timedOut
      };
    },
    async kill(input) {
      await requireConnection().acpExecKill(input.sessionKey, { execId: input.execId });
    }
  };
}
