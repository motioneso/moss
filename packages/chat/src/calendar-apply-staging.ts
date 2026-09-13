// Staged apply writes for reserved calendar moves and removals (R2.2-T05).
// The execution service never lends a transaction to provider I/O, so the
// apply path stages its own short transactions around database reads alone
// and runs every token refresh and provider call with none open. Interactive
// focus blocks keep using the caller-provided transaction untouched.
import { type AccessContext, type DataContextDb, type DataContextRunner } from "@moss/db";
import {
  resolveCalendarEventRef,
  type CalendarRepository,
  type DeleteEventResult,
  type RescheduleEventResult
} from "@moss/calendar";
import {
  GoogleApiError,
  featureGrantsPrefKey,
  isFeatureGranted,
  type ConnectorsRepository,
  type GoogleApiClient,
  type GoogleConnectionService
} from "@moss/connectors";
import type { ToolContext } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

export interface CalendarApplyStagingDeps {
  readonly googleService: GoogleConnectionService;
  readonly googleApiClient: GoogleApiClient;
  readonly connectorsRepository: ConnectorsRepository;
  readonly calendarRepository: CalendarRepository;
  readonly preferencesRepository?: Pick<PreferencesRepository, "get">;
  readonly enqueueCacheEvict?: (eventId: string, actorUserId: string) => Promise<string | null>;
}

export type StagedRunner = Pick<DataContextRunner, "withDataContext">;

interface ApplyStagedReads {
  readonly accountId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly grantedScopes: string[];
  readonly accessToken: string;
  readonly tokenExpiry: string;
}

export async function isCalendarFeatureGranted(
  deps: CalendarApplyStagingDeps,
  scopedDb: DataContextDb,
  accountId: string
): Promise<boolean> {
  const preferencesRepository = deps.preferencesRepository ?? new PreferencesRepository();
  const featureGrants = await preferencesRepository.get(scopedDb, featureGrantsPrefKey(accountId));
  return isFeatureGranted(featureGrants, "calendar");
}

// Stage 1: account, permission, credential and scope reads in one short
// transaction. Nothing here touches the network.
export async function readApplyReads(
  deps: CalendarApplyStagingDeps,
  dataContext: StagedRunner,
  access: AccessContext
): Promise<{ readonly denied: string } | { readonly reads: ApplyStagedReads }> {
  return dataContext.withDataContext(access, async (scopedDb) => {
    const calendarScope = await deps.connectorsRepository.getCalendarWriteScopeState(scopedDb);
    if (!calendarScope?.hasScope) {
      return {
        denied:
          "Your Google connection doesn't have calendar-write permission yet — reconnect in Settings to grant it."
      };
    }
    if (!(await isCalendarFeatureGranted(deps, scopedDb, calendarScope.accountId))) {
      return { denied: "Calendar access is disabled for this account in Settings." };
    }
    const credential = await deps.googleService.readActiveCredential(scopedDb);
    if (!credential) {
      return { denied: "Connect Google in Settings first." };
    }
    return {
      reads: {
        accountId: credential.accountId,
        clientId: credential.bundle.clientId,
        clientSecret: credential.bundle.clientSecret,
        refreshToken: credential.bundle.refreshToken,
        grantedScopes: [...credential.bundle.grantedScopes],
        accessToken: credential.bundle.accessToken,
        tokenExpiry: credential.bundle.tokenExpiry
      }
    };
  });
}

// Stage 2: token refresh runs with no transaction open; the refreshed
// credential persists in a new short transaction only after confirming the
// same account is still active with the same refresh token.
export async function ensureApplyToken(
  deps: CalendarApplyStagingDeps,
  dataContext: StagedRunner,
  access: AccessContext,
  reads: ApplyStagedReads
): Promise<{ readonly accessToken: string } | { readonly denied: string }> {
  if (new Date(reads.tokenExpiry).getTime() - Date.now() > 60_000) {
    return { accessToken: reads.accessToken };
  }
  let refreshed: { accessToken: string; tokenExpiry: string };
  try {
    refreshed = await deps.googleService.refreshCredential({
      clientId: reads.clientId,
      clientSecret: reads.clientSecret,
      refreshToken: reads.refreshToken
    });
  } catch {
    return { denied: "Couldn't refresh your Google access — reconnect in Settings." };
  }
  const stored = await dataContext.withDataContext(access, (scopedDb) =>
    deps.googleService.storeRefreshedCredential(
      scopedDb,
      { accountId: reads.accountId, refreshToken: reads.refreshToken },
      {
        clientId: reads.clientId,
        clientSecret: reads.clientSecret,
        accessToken: refreshed.accessToken,
        tokenExpiry: refreshed.tokenExpiry,
        grantedScopes: reads.grantedScopes
      }
    )
  );
  if (!stored) {
    return { denied: "Your Google connection changed during the request — reconnect in Settings." };
  }
  return { accessToken: refreshed.accessToken };
}

// Reserved apply removal with staged transactions: reads, then the provider
// delete with no transaction open, then best-effort cache eviction outside
// any transaction. Accepts the stored provider reference (moss id or
// provider id) and resolves it internally, since deleteEvent takes the
// cached uuid on the interactive path.
export async function deleteApplyEvent(
  deps: CalendarApplyStagingDeps,
  dataContext: StagedRunner,
  access: AccessContext,
  ctx: ToolContext,
  eventRef: string
): Promise<DeleteEventResult> {
  const skipped = (message: string): DeleteEventResult => ({
    deleted: false,
    googleDeleted: "skipped-error",
    cacheMirror: "not-cached",
    message
  });
  const staged = await readApplyReads(deps, dataContext, access);
  if ("denied" in staged) return skipped(staged.denied);
  const token = await ensureApplyToken(deps, dataContext, access, staged.reads);
  if ("denied" in token) return skipped(token.denied);
  // Resolve the ref in a short transaction, closed before provider I/O.
  const resolved = await dataContext.withDataContext(access, async (scopedDb) => {
    const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
    const outcome = await resolveCalendarEventRef(
      scopedDb,
      deps.calendarRepository,
      active?.id,
      eventRef
    );
    if (!outcome.found) return undefined;
    const md = outcome.event.external_metadata as Record<string, unknown> | null;
    return {
      cacheId: outcome.event.id,
      externalId: outcome.event.external_id,
      title: outcome.event.title,
      calendarId: (md?.calendarId as string | undefined) ?? "primary"
    };
  });
  if (!resolved) {
    return skipped("That event isn't in your calendar — it may already be gone.");
  }
  let googleDeleted: "deleted" | "already-gone";
  try {
    const result = await deps.googleApiClient.deleteEvent({
      accessToken: token.accessToken,
      calendarId: resolved.calendarId,
      eventId: resolved.externalId
    });
    googleDeleted = result.deleted;
  } catch (error) {
    if (error instanceof GoogleApiError && error.statusCode === 403) {
      return skipped("You don't have permission to delete events on that calendar.");
    }
    return skipped("Couldn't delete the event — try again.");
  }
  let cacheMirror: DeleteEventResult["cacheMirror"];
  if (deps.enqueueCacheEvict) {
    try {
      await deps.enqueueCacheEvict(resolved.cacheId, ctx.actorUserId);
      cacheMirror = "queued";
    } catch {
      cacheMirror = "skipped-error";
    }
  } else {
    cacheMirror = "skipped-error";
  }
  return { deleted: true, googleDeleted, cacheMirror, deletedTitle: resolved.title };
}

// Reserved apply move with staged transactions: resolve, provider patch with
// no transaction open, then a fresh transaction for the cache mirror. Same
// event id throughout, never delete-then-create. The attendee refusal holds
// here exactly as on the interactive path.
export async function rescheduleApplyEvent(
  deps: CalendarApplyStagingDeps,
  dataContext: StagedRunner,
  access: AccessContext,
  eventRef: string,
  newStart: Date,
  newEnd: Date
): Promise<RescheduleEventResult> {
  const staged = await readApplyReads(deps, dataContext, access);
  if ("denied" in staged) {
    return { ok: false, reason: "no_scope", message: staged.denied };
  }
  const token = await ensureApplyToken(deps, dataContext, access, staged.reads);
  if ("denied" in token) {
    return { ok: false, reason: "provider_error", message: token.denied };
  }
  const resolved = await dataContext.withDataContext(access, async (scopedDb) => {
    const active = await deps.connectorsRepository.getActiveGoogleAccountSecret(scopedDb);
    const outcome = await resolveCalendarEventRef(
      scopedDb,
      deps.calendarRepository,
      active?.id,
      eventRef
    );
    if (!outcome.found) return undefined;
    const md = outcome.event.external_metadata as Record<string, unknown> | null;
    return {
      cacheId: outcome.event.id,
      accountId: outcome.event.connector_account_id,
      externalId: outcome.event.external_id,
      title: outcome.event.title,
      attendeeCount: typeof md?.attendeeCount === "number" ? md.attendeeCount : 0,
      calendarId: (md?.calendarId as string | undefined) ?? "primary"
    };
  });
  if (!resolved) return { ok: false, reason: "not_found" };
  if (resolved.attendeeCount > 0) return { ok: false, reason: "has_attendees" };
  try {
    await deps.googleApiClient.patchEvent(
      token.accessToken,
      resolved.calendarId,
      resolved.externalId,
      {
        start: { dateTime: newStart.toISOString(), timeZone: "UTC" },
        end: { dateTime: newEnd.toISOString(), timeZone: "UTC" }
      }
    );
  } catch (error) {
    if (error instanceof GoogleApiError && error.statusCode === 403) {
      return {
        ok: false,
        reason: "provider_error",
        message: "You don't have permission to reschedule events on that calendar."
      };
    }
    return {
      ok: false,
      reason: "provider_error",
      message: "Couldn't reschedule the event — try again."
    };
  }
  try {
    const mirrored = await dataContext.withDataContext(access, (scopedDb) =>
      deps.calendarRepository.upsertCachedEvent(scopedDb, {
        connectorAccountId: resolved.accountId,
        externalId: resolved.externalId,
        title: resolved.title,
        startsAt: newStart,
        endsAt: newEnd
      })
    );
    return { ok: true, calendarEventId: mirrored.id };
  } catch {
    return { ok: true, calendarEventId: resolved.cacheId };
  }
}
