import type { PgBoss, QueueOptions } from "pg-boss";

import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";
import { assertModuleJobPayload, type ExternalModuleJobPayload } from "@moss/jobs";
import { DEFAULT_LOCALE_SETTINGS } from "@moss/shared";

import type { ExternalModuleDiscovery } from "./types.js";

// Prefix the job library reserves for its own internal queues (for example the
// timekeeper's `__pgboss__send-it` maintenance queue). Those names never belong
// to a module, so the orphan purge below must leave them alone.
const PG_BOSS_INTERNAL_PREFIX = "__pgboss__";

export class ExternalModuleJobReconciler {
  private readonly registrations = new Map<string, Map<string, string>>();
  private readonly ownedQueues = new Map<string, readonly ExternalModuleQueueDeclaration[]>();

  constructor(
    private readonly deps: {
      readonly boss: PgBoss;
      readonly discoveries: () => readonly ExternalModuleDiscovery[];
      readonly reservedQueueNames?: ReadonlySet<string>;
      readonly isModuleEnabled: (moduleId: string) => Promise<boolean>;
      readonly listActiveUserIds: (moduleId: string) => Promise<readonly string[]>;
      /** True only when an admin disabled the module. Hash drift and a missing discovery are not. */
      readonly isModuleDisabledByAdmin?: (moduleId: string) => Promise<boolean>;
      /** Cancels waiting jobs. Absent means lifecycle changes leave queued rows alone. */
      readonly jobSweep?: {
        readonly listPendingActors: (moduleId: string) => Promise<readonly string[]>;
        readonly cancel: (input: {
          readonly moduleId: string;
          readonly actorUserId?: string;
        }) => Promise<{ readonly cancelled: number; readonly leftActive: number }>;
        /** Schedules a later reconcile that repeats the sweep for rows that were running. */
        readonly scheduleFollowUp: (moduleId: string) => Promise<void>;
      };
      /** The actor's effective timezone, for schedules that declare none. */
      readonly resolveActorTimezone?: (actorUserId: string) => Promise<string>;
      readonly registerWorker?: (
        module: ExternalModuleDiscovery,
        queue: ExternalModuleQueueDeclaration
      ) => Promise<void>;
      readonly logger?: { warn(data: Record<string, unknown>, message?: string): void };
    }
  ) {}

  private async actorTimezone(actorUserId: string): Promise<string> {
    try {
      return (
        (await this.deps.resolveActorTimezone?.(actorUserId)) ?? DEFAULT_LOCALE_SETTINGS.timezone
      );
    } catch (error) {
      // One person's unreadable zone must not stop the module for everyone.
      this.deps.logger?.warn({ err: error, actorUserId }, "actor timezone read failed");
      return DEFAULT_LOCALE_SETTINGS.timezone;
    }
  }

  async reconcileAll(): Promise<void> {
    const discoveries = this.deps.discoveries();
    for (const module of discoveries) {
      try {
        await this.reconcileModule(module.id);
      } catch (error) {
        try {
          await this.stopModule(module.id);
        } catch {
          // Later startup/control reconciliation retries cleanup; never block sibling modules.
        }
        this.deps.logger?.warn(
          { moduleId: module.id, errorName: error instanceof Error ? error.name : "Error" },
          "external module job reconcile failed"
        );
      }
    }
    const discoveredIds = new Set(discoveries.map((module) => module.id));
    for (const moduleId of this.ownedQueues.keys()) {
      if (!discoveredIds.has(moduleId)) await this.purgeModule(moduleId);
    }
    if (this.deps.reservedQueueNames) {
      for (const schedule of await this.deps.boss.getSchedules()) {
        const moduleId = schedule.key.split("/", 1)[0];
        if (
          moduleId &&
          !discoveredIds.has(moduleId) &&
          !this.deps.reservedQueueNames.has(schedule.name) &&
          !schedule.name.startsWith(PG_BOSS_INTERNAL_PREFIX) &&
          schedule.name.startsWith(`${moduleId}.`)
        ) {
          await this.deps.boss.unschedule(schedule.name, schedule.key);
        }
      }
      for (const queue of await this.deps.boss.getQueues()) {
        const moduleId = queue.name.split(".", 1)[0];
        if (
          moduleId &&
          !discoveredIds.has(moduleId) &&
          !this.deps.reservedQueueNames.has(queue.name) &&
          !queue.name.startsWith(PG_BOSS_INTERNAL_PREFIX)
        ) {
          await this.deps.boss.deleteQueue(queue.name);
        }
      }
    }
  }

  async reconcileUser(_userId: string): Promise<void> {
    // ponytail: full pass keeps one reconciliation path; add targeted fan-out if scale demands it.
    await this.reconcileAll();
  }

  async reconcileModule(moduleId: string): Promise<void> {
    const module = this.deps.discoveries().find((item) => item.id === moduleId);
    if (!module) {
      await this.purgeModule(moduleId);
      return;
    }
    if (!(await this.deps.isModuleEnabled(moduleId))) {
      await this.stopModule(moduleId);
      // Only an explicit admin disable cancels waiting jobs. Hash drift and a missing
      // discovery are transient and keep their rows.
      if (await this.deps.isModuleDisabledByAdmin?.(moduleId)) {
        await this.sweepDisabledModule(moduleId);
      }
      return;
    }
    const queues = module.manifest.worker?.queues ?? [];
    const previousQueues = this.ownedQueues.get(moduleId) ?? [];
    this.ownedQueues.set(moduleId, queues);
    const targets = new Set(queues.flatMap((queue) => queue.deadLetterQueue ?? []));
    for (const queue of [...queues].sort(
      (a, b) => Number(targets.has(b.name)) - Number(targets.has(a.name))
    )) {
      await this.reconcileQueue(queue);
    }
    if (this.deps.registerWorker) {
      const current = this.registrations.get(moduleId) ?? new Map<string, string>();
      const desiredNames = new Set(queues.map((queue) => queue.name));
      for (const name of current.keys()) {
        if (!desiredNames.has(name)) {
          await this.deps.boss.offWork(name);
          current.delete(name);
        }
      }
      for (const queue of queues) {
        const signature = `${module.manifestHash}:${JSON.stringify(queue)}`;
        if (current.get(queue.name) === signature) continue;
        if (current.has(queue.name)) await this.deps.boss.offWork(queue.name);
        await this.deps.registerWorker(module, queue);
        current.set(queue.name, signature);
      }
      this.registrations.set(moduleId, current);
    }
    const desiredQueueNames = new Set(queues.map((queue) => queue.name));
    const previousTargets = new Set(previousQueues.flatMap((queue) => queue.deadLetterQueue ?? []));
    for (const queue of [...previousQueues]
      .filter((queue) => !desiredQueueNames.has(queue.name))
      .sort((a, b) => Number(previousTargets.has(a.name)) - Number(previousTargets.has(b.name)))) {
      await this.deps.boss.deleteQueue(queue.name);
    }

    const desiredScheduleKeys = new Set<string>();
    const users = await this.deps.listActiveUserIds(moduleId);
    await this.sweepActorsWithoutAccess(moduleId, users);
    const queueByName = new Map(queues.map((queue) => [queue.name, queue]));
    for (const schedule of module.manifest.worker?.schedules ?? []) {
      const queue = queueByName.get(schedule.queue);
      if (!queue) continue;
      for (const actorUserId of users) {
        // "/" separator, NOT ":" — pg-boss v12's assertKey restricts schedule
        // keys to [\w.\-/], and a rejected key here threw AssertionError out of
        // reconcileModule, whose caller then stopModule'd every queue worker
        // for the module (finance UAT #1147: jobs sat in "created" forever).
        // moduleId's charset ([a-z0-9-]) cannot contain "/", so the prefix
        // parse in reconcileAll/stopModule stays unambiguous.
        const key = `${moduleId}/${schedule.id}/${actorUserId}`;
        const payload: ExternalModuleJobPayload = {
          actorUserId,
          moduleId,
          jobKind: schedule.jobKind,
          manifestHash: module.manifestHash,
          ...(schedule.params === undefined ? {} : { params: schedule.params })
        };
        assertModuleJobPayload(queue, payload);
        // The zone is fixed here; a later zone change applies on the next reconcile.
        await this.deps.boss.schedule(queue.name, schedule.cron, payload, {
          tz: schedule.tz ?? (await this.actorTimezone(actorUserId)),
          key
        });
        desiredScheduleKeys.add(key);
      }
    }
    for (const schedule of await this.deps.boss.getSchedules()) {
      if (
        schedule.key.startsWith(`${moduleId}/`) &&
        schedule.name.startsWith(`${moduleId}.`) &&
        !desiredScheduleKeys.has(schedule.key)
      ) {
        await this.deps.boss.unschedule(schedule.name, schedule.key);
      }
    }

    // #1166 F6-D4: one-shot per-user enqueue on every reconcile. "/" separator,
    // NOT ":" — pg-boss v12 assertKey restricts keys to [\w.\-/] (#1147 lesson).
    // Dedup here is best-effort (concurrent sends only); the real replay guard is
    // the handler's idempotency marker.
    for (const job of module.manifest.worker?.reconcileJobs ?? []) {
      const queue = queueByName.get(job.queue);
      if (!queue) continue;
      for (const actorUserId of users) {
        const payload: ExternalModuleJobPayload = {
          actorUserId,
          moduleId,
          jobKind: job.jobKind,
          manifestHash: module.manifestHash
        };
        assertModuleJobPayload(queue, payload);
        await this.deps.boss.send(queue.name, payload, {
          singletonKey: `${moduleId}/${job.id}/${actorUserId}`
        });
      }
    }
  }

  async purgeModule(moduleId: string): Promise<void> {
    await this.stopModule(moduleId);
    const queues = this.ownedQueues.get(moduleId) ?? [];
    const targets = new Set(queues.flatMap((queue) => queue.deadLetterQueue ?? []));
    for (const queue of [...queues].sort(
      (a, b) => Number(targets.has(a.name)) - Number(targets.has(b.name))
    )) {
      await this.deps.boss.deleteQueue(queue.name);
    }
    this.ownedQueues.delete(moduleId);
  }

  async close(): Promise<void> {
    for (const [moduleId, registrations] of this.registrations) {
      for (const queueName of registrations.keys()) await this.deps.boss.offWork(queueName);
      this.registrations.delete(moduleId);
    }
  }

  private async sweepDisabledModule(moduleId: string): Promise<void> {
    const sweep = this.deps.jobSweep;
    if (!sweep) return;
    const result = await sweep.cancel({ moduleId });
    if (result.leftActive > 0) await sweep.scheduleFollowUp(moduleId);
  }

  /** Cancels waiting rows for actors who lost access, one actor at a time. */
  private async sweepActorsWithoutAccess(
    moduleId: string,
    activeUserIds: readonly string[]
  ): Promise<void> {
    const sweep = this.deps.jobSweep;
    if (!sweep) return;
    const active = new Set(activeUserIds);
    try {
      for (const actorUserId of await sweep.listPendingActors(moduleId)) {
        if (!active.has(actorUserId)) await sweep.cancel({ moduleId, actorUserId });
      }
    } catch (error) {
      // A failed cleanup must not stop the module for everyone; the next pass retries it.
      this.deps.logger?.warn(
        { moduleId, errorName: error instanceof Error ? error.name : "Error" },
        "module job access-loss sweep failed"
      );
    }
  }

  private async stopModule(moduleId: string): Promise<void> {
    const registrations = this.registrations.get(moduleId);
    if (registrations) {
      for (const queueName of registrations.keys()) await this.deps.boss.offWork(queueName);
      this.registrations.delete(moduleId);
    }
    for (const schedule of await this.deps.boss.getSchedules()) {
      if (schedule.key.startsWith(`${moduleId}/`) && schedule.name.startsWith(`${moduleId}.`)) {
        await this.deps.boss.unschedule(schedule.name, schedule.key);
      }
    }
  }

  private async reconcileQueue(queue: ExternalModuleQueueDeclaration): Promise<void> {
    const options: QueueOptions = {
      ...(queue.retryLimit === undefined ? {} : { retryLimit: queue.retryLimit }),
      ...(queue.deadLetterQueue === undefined ? {} : { deadLetter: queue.deadLetterQueue })
    };
    if (!(await this.deps.boss.getQueue(queue.name))) {
      await this.deps.boss.createQueue(queue.name, options);
    }
    if (Object.keys(options).length > 0) await this.deps.boss.updateQueue(queue.name, options);
  }
}
