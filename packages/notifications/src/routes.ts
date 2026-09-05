import type { FastifyInstance, FastifyRequest } from "fastify";

import { HttpError, handleRouteError } from "@moss/module-sdk";
import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  deletePushSubscriptionRouteSchema,
  listNotificationsRouteSchema,
  markAllNotificationsReadRouteSchema,
  markNotificationReadRouteSchema,
  pushConfigRouteSchema,
  registerPushSubscriptionRouteSchema,
  type NotificationDto,
  type PushDeviceDto,
  type RegisterPushSubscriptionRequest
} from "@moss/shared";

import { projectNotificationMetadata } from "./metadata.js";
import { createPushSigningCipher, getOrGeneratePushSigningKey } from "./push-crypto.js";
import {
  PushSubscriptionInvalidError,
  validatePushSubscriptionInput
} from "./push-endpoint-policy.js";
import {
  PushSubscriptionLimitError,
  PushSubscriptionsRepository,
  type PushSubscriptionDevice
} from "./push-subscriptions-repository.js";
import { NotificationsRepository, type NotificationWithReadState } from "./repository.js";

export interface NotificationsRoutesDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: NotificationsRepository;
  readonly pushSubscriptionsRepository?: PushSubscriptionsRepository;
  readonly pushSigningCipher?: ReturnType<typeof createPushSigningCipher>;
}

interface NotificationParams {
  readonly id: string;
}

export function registerNotificationsRoutes(
  server: FastifyInstance,
  dependencies: NotificationsRoutesDependencies
): void {
  const repository = dependencies.repository ?? new NotificationsRepository();
  const pushSubscriptionsRepository =
    dependencies.pushSubscriptionsRepository ?? new PushSubscriptionsRepository();
  const pushSigningCipher = dependencies.pushSigningCipher ?? createPushSigningCipher();

  server.get(
    "/api/notifications",
    { schema: listNotificationsRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.listVisible(scopedDb)
        );

        return {
          notifications: result.notifications.map(serializeNotification),
          unreadCount: result.unreadCount,
          // #1285: per-module unread breakdown for the nav badge — see repository.ts for why
          // it is safe to trust without a re-derived RLS check (same scopedDb, same query).
          unreadByModule: result.unreadByModule
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/notifications/read-all",
    { schema: markAllNotificationsReadRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const unreadCount = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.markAllRead(scopedDb)
        );

        return { unreadCount };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: NotificationParams }>(
    "/api/notifications/:id/read",
    { schema: markNotificationReadRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const notification = await dependencies.dataContext.withDataContext(
          accessContext,
          (scopedDb) => repository.markRead(scopedDb, request.params.id)
        );

        // 404 covers BOTH "notification does not exist" AND "exists but RLS-invisible to
        // this actor" — intentionally indistinguishable so callers cannot probe for
        // existence. See the docblock on NotificationsRepository.markRead.
        if (!notification) {
          return reply.code(404).send({ error: "Notification not found" });
        }

        return { notification: serializeNotification(notification) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/notifications/push/config",
    { schema: pushConfigRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);

        return await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
          // The VAPID subject is never taken from the request (#743 finding 5); see
          // resolveVapidSubject in push-crypto.ts.
          const signingKey = await getOrGeneratePushSigningKey(scopedDb, pushSigningCipher);
          const devices = await pushSubscriptionsRepository.listForActor(scopedDb);

          return {
            publicKey: signingKey.publicKey,
            enabledDevices: devices.map(serializePushDevice)
          };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Body: RegisterPushSubscriptionRequest }>(
    "/api/notifications/push/subscriptions",
    { schema: registerPushSubscriptionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const userAgentLabel = parseUserAgentLabel(request.headers["user-agent"]);

        // #743 security finding 1: the JSON schema only checks shape. This parses the
        // address and refuses non-https, credentials, IP literals and private hosts
        // before anything is stored or ever contacted.
        const input = validatePushSubscriptionInput({
          endpoint: request.body.endpoint,
          p256dh: request.body.keys.p256dh,
          auth: request.body.keys.auth
        });

        const device = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          pushSubscriptionsRepository.upsert(scopedDb, {
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgentLabel
          })
        );

        return { device: serializePushDevice(device) };
      } catch (error) {
        if (error instanceof PushSubscriptionInvalidError) {
          return handleRouteError(new HttpError(400, error.message), reply);
        }
        if (error instanceof PushSubscriptionLimitError) {
          return handleRouteError(new HttpError(409, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: NotificationParams }>(
    "/api/notifications/push/subscriptions/:id",
    { schema: deletePushSubscriptionRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const success = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          pushSubscriptionsRepository.delete(scopedDb, request.params.id)
        );

        // Missing and not-owned are indistinguishable (security review 1, finding 3):
        // the repository's owner predicate returns false for both.
        if (!success) {
          return reply.code(404).send({ error: "Push device not found" });
        }

        return { success };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}

/** Serialize a stored push subscription row into the client-facing device DTO. */
function serializePushDevice(subscription: PushSubscriptionDevice): PushDeviceDto {
  return {
    id: subscription.id,
    label: subscription.user_agent_label,
    createdAt: toIsoString(subscription.created_at) ?? new Date(0).toISOString(),
    lastUsedAt: toIsoString(subscription.last_used_at),
    disabledAt: toIsoString(subscription.disabled_at)
  };
}

/**
 * A short "browser on OS" label for the settings device list, e.g. "Chrome on macOS". Not
 * reused from `@moss/auth`'s session UA parser: that helper is module-private, and importing
 * it would cross a module boundary for a few lines of string matching (module isolation).
 * Order matters — Edge and Chrome both include "Chrome" in their UA string, so Edge must be
 * checked first, and so on.
 */
function parseUserAgentLabel(userAgent: string | undefined): string | null {
  if (!userAgent) {
    return null;
  }

  let browser = "Unknown browser";
  if (/Edg\//.test(userAgent)) {
    browser = "Edge";
  } else if (/OPR\//.test(userAgent)) {
    browser = "Opera";
  } else if (/Firefox\//.test(userAgent)) {
    browser = "Firefox";
  } else if (/CriOS\//.test(userAgent)) {
    browser = "Chrome";
  } else if (/Chrome\//.test(userAgent)) {
    browser = "Chrome";
  } else if (/Safari\//.test(userAgent)) {
    browser = "Safari";
  }

  let os = "Unknown OS";
  if (/Windows/.test(userAgent)) {
    os = "Windows";
  } else if (/Mac OS X/.test(userAgent)) {
    os = "macOS";
  } else if (/Android/.test(userAgent)) {
    os = "Android";
  } else if (/iPhone|iPad|iPod/.test(userAgent)) {
    os = "iOS";
  } else if (/Linux/.test(userAgent)) {
    os = "Linux";
  }

  return `${browser} on ${os}`;
}

/**
 * Serialize a stored notification row into the client-facing DTO.
 *
 * `metadata` is re-projected here on the way out (Decision 3b). This is the single
 * output chokepoint: the REST GET route and the `notifications.listVisible` assistant
 * tool (tools.ts imports this function) both pass through it, so a backfill or producer
 * bug that wrote oversized / nested / oddly-keyed jsonb cannot reach either client
 * surface. Fastify's response schema is NOT relied on to strip fields — there is no
 * global `removeAdditional` AJV config and adding one is out of scope.
 */
export function serializeNotification(notification: NotificationWithReadState): NotificationDto {
  return {
    id: notification.id,
    moduleId: notification.module_id,
    actorUserId: notification.actor_user_id,
    recipientUserId: notification.recipient_user_id,
    title: notification.title,
    body: notification.body,
    metadata: projectNotificationMetadata(notification.metadata),
    readAt: toIsoString(notification.read_at),
    createdAt: toIsoString(notification.created_at),
    href: notification.href
  };
}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}
