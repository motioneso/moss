import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import { defaultProactiveMonitoringPreference, type ProactiveSource } from "@moss/shared";

import { CardRepository, serializeCard } from "./card-repository.js";
import { enqueueProactiveScan } from "./jobs.js";
import { MonitorStateRepository } from "./monitor-state-repository.js";
import {
  isProactiveSourceEnabled,
  ProactiveMonitoringPreferencesRepository
} from "./preferences-repository.js";

export interface ProactiveMonitoringRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  /** Resolve the actor’s available registered sources fresh for each refresh. */
  readonly resolveRegisteredSources: (actorUserId: string) => Promise<ReadonlySet<ProactiveSource>>;
  readonly cardRepository?: CardRepository;
  readonly preferencesRepository?: ProactiveMonitoringPreferencesRepository;
  readonly monitorStateRepository?: MonitorStateRepository;
}

const MAX_CARDS_LIMIT = 20;
/** Per-user per-source cooldown: no manual refresh more than once per 15 minutes. */
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

export function registerProactiveMonitoringRoutes(
  server: FastifyInstance,
  dependencies: ProactiveMonitoringRoutesDependencies
): void {
  const cardRepository = dependencies.cardRepository ?? new CardRepository();
  const prefsRepo =
    dependencies.preferencesRepository ?? new ProactiveMonitoringPreferencesRepository();
  const monitorStateRepo = dependencies.monitorStateRepository ?? new MonitorStateRepository();

  server.get("/api/me/proactive-cards", async (request, reply) => {
    try {
      const ctx = await dependencies.resolveAccessContext(request);
      const query = request.query as { limit?: string };
      const limit = Math.min(parseInt(query.limit ?? "5", 10) || 5, MAX_CARDS_LIMIT);

      const cards = await dependencies.dataContext.withDataContext(ctx, (scopedDb) =>
        cardRepository.listActive(scopedDb, ctx.actorUserId, limit)
      );

      return reply.send({ cards: cards.map(serializeCard) });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });

  server.post("/api/me/proactive-cards/refresh", async (request, reply) => {
    try {
      const ctx = await dependencies.resolveAccessContext(request);
      const sources: ProactiveSource[] = ["tasks", "calendar", "email", "notes"];

      const { pref, savedPreference, monitorStates } =
        await dependencies.dataContext.withDataContext(ctx, async (scopedDb) => {
          const savedPreference = await prefsRepo.getSaved(scopedDb);
          const pref = savedPreference?.preference ?? defaultProactiveMonitoringPreference();
          const stateEntries = await Promise.all(
            sources.map(
              async (s) => [s, await monitorStateRepo.get(scopedDb, ctx.actorUserId, s)] as const
            )
          );
          return { pref, savedPreference, monitorStates: new Map(stateEntries) };
        });

      // Time-window slot: stable for the duration of the cooldown window, so the idempotency
      // key does not rotate on each HTTP request (which would let rapid clicks flood the queue).
      const windowSlot = Math.floor(Date.now() / REFRESH_COOLDOWN_MS);
      const registeredSources = await dependencies.resolveRegisteredSources(ctx.actorUserId);
      let enqueued = 0;
      for (const source of sources) {
        if (!isProactiveSourceEnabled(pref, source, savedPreference)) {
          continue;
        }
        if (!registeredSources.has(source)) continue;

        const state = monitorStates.get(source);
        if (
          state?.last_checked_at &&
          Date.now() - state.last_checked_at.getTime() < REFRESH_COOLDOWN_MS
        ) {
          continue;
        }

        const idempotencyKey = `manual-refresh:${ctx.actorUserId}:${source}:${windowSlot}`;
        await enqueueProactiveScan(
          dependencies.boss,
          ctx.actorUserId,
          source,
          "manual-refresh",
          idempotencyKey
        );
        enqueued++;
      }

      return reply.status(202).send({ enqueued });
    } catch (err) {
      return handleRouteError(err, reply);
    }
  });
}
