import type { FastifyInstance } from "fastify";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import {
  outlookCalendarActionRouteSchema,
  outlookCalendarStatusRouteSchema,
  type OutlookCalendarStatus
} from "@moss/shared";
import { createConnectorSecretCipher } from "./crypto.js";
import {
  outlookBindingFingerprint,
  outlookBindingKey,
  outlookCalendarBinding,
  OUTLOOK_BROWSER_PROVIDER
} from "./outlook-calendar-config.js";
import {
  outlookHealthKey,
  readOutlookHealth,
  requestOutlookCalendarSync
} from "./outlook-calendar-jobs.js";
import { featureGrantsPrefKey } from "./feature-grants.js";
import { ConnectorsRepository } from "./repository.js";
import type { ConnectorsRoutesDependencies } from "./routes.js";

export function registerOutlookCalendarRoutes(
  server: FastifyInstance,
  deps: ConnectorsRoutesDependencies
): void {
  const binding = outlookCalendarBinding();
  const repo = deps.repository ?? new ConnectorsRepository();
  const prefs = deps.preferencesRepository ?? new PreferencesRepository();
  const cipher = deps.secretCipher ?? createConnectorSecretCipher();
  const status = async (actorUserId: string): Promise<OutlookCalendarStatus> =>
    deps.dataContext.withDataContext({ actorUserId }, async (db) => {
      const account = (await repo.listAccounts(db)).find(
        (a) => a.provider_id === OUTLOOK_BROWSER_PROVIDER
      );
      const connected = account?.status === "active";
      const health = account
        ? readOutlookHealth(await prefs.get(db, outlookHealthKey(account.id)))
        : { state: "disconnected" as const };
      const stalled =
        health.state === "collecting" &&
        !!health.attemptedAt &&
        Date.now() - Date.parse(health.attemptedAt) > 2 * 60_000;
      const stale =
        health.state === "current" &&
        (!health.lastCompleteAt || Date.now() - Date.parse(health.lastCompleteAt) > 15 * 60_000);
      return {
        available: binding?.ownerUserId === actorUserId,
        connected,
        state: !connected ? "disconnected" : stale || stalled ? "stale" : health.state,
        lastCompleteAt: health.lastCompleteAt ?? null,
        windowStart: health.windowStart ?? null,
        windowEnd: health.windowEnd ?? null,
        unconfirmed: health.unconfirmed ?? 0
      };
    });
  server.get(
    "/api/connectors/outlook-calendar",
    { schema: outlookCalendarStatusRouteSchema },
    async (req, reply) => {
      try {
        return await status((await deps.resolveAccessContext(req)).actorUserId);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  for (const action of ["connect", "refresh", "disconnect"] as const) {
    server.post(
      `/api/connectors/outlook-calendar/${action}`,
      { schema: outlookCalendarActionRouteSchema },
      async (req, reply) => {
        try {
          const access = await deps.resolveAccessContext(req);
          if (!binding || binding.ownerUserId !== access.actorUserId)
            throw new HttpError(
              403,
              "No dedicated Outlook browser is configured for this account."
            );
          await deps.dataContext.withDataContext(access, async (db) => {
            await repo.lockAccountSync(db, access.actorUserId);
            let account = (await repo.listAccounts(db)).find(
              (a) => a.provider_id === OUTLOOK_BROWSER_PROVIDER
            );
            const fingerprint = outlookBindingFingerprint(binding);
            if (account && action !== "disconnect") {
              const stored = await prefs.get(db, outlookBindingKey(account.id));
              if (stored !== fingerprint)
                throw new HttpError(
                  409,
                  "Dedicated browser binding changed. Restore the configured source before reconnecting."
                );
            }
            if (action === "disconnect") {
              if (account) {
                await repo.revokeAccount(db, account.id, cipher.encryptJson({ revoked: true }));
                const health = readOutlookHealth(await prefs.get(db, outlookHealthKey(account.id)));
                await prefs.upsert(db, outlookHealthKey(account.id), {
                  ...health,
                  state: "disconnected"
                });
              }
              return;
            }
            if (action === "refresh" && account?.status !== "active")
              throw new HttpError(409, "Connect Outlook calendar first.");
            if (!account)
              account = await repo.createAccount(db, {
                providerId: OUTLOOK_BROWSER_PROVIDER,
                scopes: ["calendar.readonly"],
                encryptedSecret: cipher.encryptJson({ kind: "browser-binding", readOnly: true })
              });
            else if (account.status !== "active")
              account = (await repo.updateAccount(db, account.id, {
                status: "active",
                scopes: ["calendar.readonly"]
              }))!;
            await prefs.upsert(db, outlookBindingKey(account.id), fingerprint);
            await prefs.upsert(db, featureGrantsPrefKey(account.id), {
              calendar: true,
              email: false
            });
            const health = readOutlookHealth(await prefs.get(db, outlookHealthKey(account.id)));
            await prefs.upsert(db, outlookHealthKey(account.id), {
              ...health,
              state: "collecting",
              attemptedAt: new Date().toISOString(),
              failures: 0
            });
          });
          if (action !== "disconnect")
            await requestOutlookCalendarSync(deps.boss, access.actorUserId);
          return await status(access.actorUserId);
        } catch (error) {
          return handleRouteError(error, reply);
        }
      }
    );
  }
}
