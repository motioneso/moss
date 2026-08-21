import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";

import { resolveMossEnv, type AccessContext, type MossDatabase } from "@moss/db";
import { sendModuleControl, sendModuleJob } from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";

// #965: five seconds catches accidental double-clicks without blocking an intentional rerun.
const MANUAL_RUN_SINGLETON_SECONDS = 5;

export function registerExternalModuleJobRoutes(
  server: FastifyInstance,
  deps: {
    readonly boss: PgBoss;
    readonly discoveries: () => readonly ExternalModuleDiscovery[];
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly isModuleActive: (access: AccessContext, moduleId: string) => Promise<boolean>;
    readonly rateLimitKey?: (request: FastifyRequest) => string;
    readonly rootDb?: Kysely<MossDatabase>;
  }
): void {
  server.post(
    "/api/modules/:moduleId/queues/:queueName/run",
    {
      config: {
        rateLimit: {
          max: Number(resolveMossEnv(process.env, "JARVIS_RL_MODULE_RUN_MAX") ?? 6),
          timeWindow: "1 minute",
          ...(deps.rateLimitKey
            ? {
                keyGenerator: (request: FastifyRequest) =>
                  `${deps.rateLimitKey!(request)}:${(request.params as { moduleId: string }).moduleId}`
              }
            : {})
        }
      }
    },
    async (request, reply) => {
      let access: AccessContext;
      try {
        access = await deps.resolveAccessContext(request);
      } catch {
        return reply.code(401).send({ error: "Session is missing or expired" });
      }
      const { moduleId, queueName } = request.params as {
        moduleId: string;
        queueName: string;
      };
      const module = deps.discoveries().find((item) => item.id === moduleId);
      const queue = module?.manifest.worker?.queues?.find((item) => item.name === queueName);
      if (!module || !queue?.allowManualRun || !(await deps.isModuleActive(access, moduleId))) {
        return reply.code(404).send({ error: "Not found" });
      }
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      const value = body as Record<string, unknown>;
      if (
        Object.keys(value).some((key) => key !== "jobKind" && key !== "params") ||
        typeof value.jobKind !== "string" ||
        (value.params !== undefined &&
          (!value.params || typeof value.params !== "object" || Array.isArray(value.params)))
      ) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      try {
        const jobId = await sendModuleJob(
          deps.boss,
          access,
          module,
          queue,
          {
            jobKind: value.jobKind,
            ...(value.params === undefined
              ? {}
              : { params: value.params as Readonly<Record<string, unknown>> })
          },
          {
            singletonKey: `manual:${moduleId}:${queueName}:${access.actorUserId}`,
            singletonSeconds: MANUAL_RUN_SINGLETON_SECONDS
          },
          deps.rootDb
        );
        return reply.code(202).send({ jobId });
      } catch (error) {
        if (error instanceof Error && /payload|params|jobKind/i.test(error.message)) {
          return reply.code(400).send({ error: "Invalid request" });
        }
        request.log.warn(
          { moduleId, errorName: (error as Error).name },
          "module run enqueue failed"
        );
        return reply.code(503).send({ error: "Service unavailable" });
      }
    }
  );
}

export async function reconcileExternalModuleUserJobs(
  boss: PgBoss,
  discoveries: readonly Pick<ExternalModuleDiscovery, "id">[],
  userId: string
): Promise<void> {
  const moduleIds = new Set(discoveries.map((module) => module.id));
  for (const schedule of await boss.getSchedules()) {
    if (
      schedule.key.endsWith(`:${userId}`) &&
      [...moduleIds].some((moduleId) => schedule.name.startsWith(`${moduleId}.`))
    ) {
      await boss.unschedule(schedule.name, schedule.key);
    }
  }
  for (const moduleId of moduleIds) {
    await sendModuleControl(boss, { moduleId, action: "reconcile" });
  }
}
