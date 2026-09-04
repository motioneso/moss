// Minimal logger — avoids a pino/fastify dependency in the connectors package (mirrors oauth.ts).
interface GoogleApiLogger {
  error(data: Record<string, unknown>, message: string): void;
}

// Silent default — production ALWAYS injects a real logger at the composition
// root (apps/api/src/server.ts passes a server.log adapter). A noop (not console)
// default means a forgotten injection degrades quietly instead of spamming
// unstructured console output (observability spec: no console.* in production).
const NOOP_GOOGLE_API_LOGGER: GoogleApiLogger = {
  error: () => undefined
};

export interface GoogleApiClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly logger?: GoogleApiLogger;
  readonly requestTimeoutMs?: number;
}

export const GOOGLE_API_REQUEST_TIMEOUT_MS = 10_000;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    /** Google's own structured error code (e.g. "PERMISSION_DENIED", "RATE_LIMIT_EXCEEDED").
     *  Non-secret — safe to log and to branch on. Undefined when the body couldn't be parsed. */
    readonly reason?: string
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * Google's error responses carry a structured, non-secret status/reason code in the body
 * (`error.status` or `error.errors[0].reason`) — the same shape already trusted for the
 * freeBusy per-calendar `reason` codes above. Callers only ever see the status number in
 * `Error.message`, never this body, so reading it here does not reopen the no-body-leak rule.
 */
async function extractGoogleErrorReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { status?: string; errors?: ReadonlyArray<{ reason?: string }> };
    };
    return body.error?.status ?? body.error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

export interface GoogleCalendarEvent {
  readonly id: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly status?: string;
  readonly htmlLink?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly attendees?: ReadonlyArray<unknown>;
}

export interface GoogleBusyInterval {
  readonly start: string;
  readonly end: string;
}

export interface GoogleFreeBusyResult {
  readonly busy: GoogleBusyInterval[];
}

export interface GoogleInsertedEvent {
  readonly id: string;
  readonly htmlLink?: string;
}

export interface GmailCreatedDraft {
  readonly id: string;
}

export interface GmailSentMessage {
  readonly id: string;
  readonly threadId?: string;
}

export interface GmailMessageStub {
  readonly id: string;
  readonly threadId?: string;
}

export interface GoogleCalendarEventsPage {
  readonly items: GoogleCalendarEvent[];
  readonly nextPageToken?: string;
}

export interface GmailMessagePage {
  readonly messages: GmailMessageStub[];
  readonly nextPageToken?: string;
}

export interface GmailMessageFull {
  readonly id: string;
  readonly threadId?: string;
  readonly historyId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly payload?: GmailPayloadPart;
  readonly internalDate?: string;
}

export interface GmailPayloadPart {
  readonly mimeType?: string;
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: readonly GmailPayloadPart[];
}

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export class GoogleApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly logger: GoogleApiLogger;
  private readonly requestTimeoutMs: number;

  constructor(deps: GoogleApiClientDeps = {}) {
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_GOOGLE_API_LOGGER;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? GOOGLE_API_REQUEST_TIMEOUT_MS;
  }

  async listCalendarEvents(input: {
    accessToken: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    maxPages?: number;
  }): Promise<GoogleCalendarEvent[]> {
    const maxPages = input.maxPages ?? 20;
    const events: GoogleCalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.listCalendarEventsPage({ ...input, pageToken });
      events.push(...result.items);
      if (!result.nextPageToken) break;
      pageToken = result.nextPageToken;
    }
    return events;
  }

  async listCalendarEventsPage(input: {
    accessToken: string;
    calendarId?: string;
    timeMin: string;
    timeMax: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GoogleCalendarEventsPage> {
    const calendarId = input.calendarId ?? "primary";
    const url = new URL(`${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", input.timeMin);
    url.searchParams.set("timeMax", input.timeMax);
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    if (input.maxResults !== undefined) {
      url.searchParams.set("maxResults", String(input.maxResults));
    }
    const json = await this.getJson<{
      items?: GoogleCalendarEvent[];
      nextPageToken?: string;
    }>(url.toString(), input.accessToken, "calendar");
    return { items: json.items ?? [], nextPageToken: json.nextPageToken };
  }

  async listMessageIds(input: {
    accessToken: string;
    query?: string;
    maxPages?: number;
  }): Promise<GmailMessageStub[]> {
    const stubs: GmailMessageStub[] = [];
    let pageToken: string | undefined;
    for (let page = 0; input.maxPages === undefined || page < input.maxPages; page += 1) {
      const result = await this.listMessageIdsPage({ ...input, pageToken });
      stubs.push(...result.messages);
      if (!result.nextPageToken) break;
      pageToken = result.nextPageToken;
    }
    return stubs;
  }

  async listMessageIdsPage(input: {
    accessToken: string;
    query?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailMessagePage> {
    const url = new URL(`${GMAIL_BASE}/users/me/messages`);
    if (input.query) url.searchParams.set("q", input.query);
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    if (input.maxResults !== undefined) {
      url.searchParams.set("maxResults", String(input.maxResults));
    }
    const json = await this.getJson<{
      messages?: GmailMessageStub[];
      nextPageToken?: string;
    }>(url.toString(), input.accessToken, "gmail");
    return { messages: json.messages ?? [], nextPageToken: json.nextPageToken };
  }

  async getMessage(input: { accessToken: string; id: string }): Promise<GmailMessageFull> {
    const url = new URL(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(input.id)}`);
    url.searchParams.set("format", "full");
    return this.getJson<GmailMessageFull>(url.toString(), input.accessToken, "gmail");
  }

  async freeBusy(input: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    calendarId?: string;
  }): Promise<GoogleFreeBusyResult> {
    const calendarId = input.calendarId ?? "primary";
    const json = await this.postJson<{
      // A freeBusy 200 can carry a PER-CALENDAR `errors[]` (e.g. notFound, rateLimitExceeded)
      // alongside an empty `busy`. We model it here so the failure is visible — without it a
      // per-calendar error reads as "fully free" and a focus block double-books over a real event.
      calendars?: Record<
        string,
        {
          busy?: GoogleBusyInterval[];
          errors?: ReadonlyArray<{ domain?: string; reason?: string }>;
        }
      >;
    }>(
      `${CALENDAR_BASE}/freeBusy`,
      input.accessToken,
      {
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        items: [{ id: calendarId }]
      },
      "calendar"
    );
    // FAIL-CLOSED: if the requested calendar key is absent OR Google reported a per-calendar
    // error for it, we CANNOT trust an empty busy list as "free". Throw so createEvent's
    // try/catch returns created:false ("couldn't check availability") instead of inserting a
    // focus block into an unverified slot (double-booking guarantee). Log status only — never
    // the body — to keep the existing no-leak posture.
    const calendar = json.calendars?.[calendarId];
    if (!calendar) {
      this.logger.error(
        { api: "calendar", reason: "freebusy-missing-calendar" },
        "Google freeBusy omitted the requested calendar"
      );
      throw new GoogleApiError(`Google calendar freeBusy missing calendar ${calendarId}`, 502);
    }
    if (calendar.errors && calendar.errors.length > 0) {
      this.logger.error(
        {
          api: "calendar",
          reason: "freebusy-calendar-error",
          // reason codes are non-secret API status tokens (notFound, rateLimitExceeded, ...)
          codes: calendar.errors.map((e) => e.reason ?? "unknown")
        },
        "Google freeBusy returned a per-calendar error"
      );
      throw new GoogleApiError(`Google calendar freeBusy reported a per-calendar error`, 502);
    }
    return { busy: calendar.busy ?? [] };
  }

  async insertEvent(input: {
    accessToken: string;
    calendarId?: string;
    summary: string;
    start: string;
    end: string;
    timeZone?: string;
    extendedPrivateProperties?: Record<string, string>;
    /**
     * Optional caller-supplied event id (base32hex, 5..1024 chars per the Google id rule).
     * When set, the insert is idempotent at Google: a second insert of the SAME id returns
     * 409 Conflict instead of creating a duplicate event. The focus-time impl derives this
     * deterministically from the approved proposal (actor + chosen slot + title) so a retry
     * of the identical approved proposal cannot double-book the real calendar.
     */
    eventId?: string;
  }): Promise<GoogleInsertedEvent> {
    const calendarId = input.calendarId ?? "primary";
    const body: Record<string, unknown> = {
      summary: input.summary,
      start: input.timeZone
        ? { dateTime: input.start, timeZone: input.timeZone }
        : { dateTime: input.start },
      end: input.timeZone
        ? { dateTime: input.end, timeZone: input.timeZone }
        : { dateTime: input.end }
    };
    if (input.eventId) {
      body.id = input.eventId;
    }
    if (input.extendedPrivateProperties) {
      body.extendedProperties = { private: input.extendedPrivateProperties };
    }
    const json = await this.postJson<GoogleInsertedEvent>(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      input.accessToken,
      body,
      "calendar"
    );
    return { id: json.id, htmlLink: json.htmlLink };
  }

  /**
   * Create a Gmail draft threaded into an existing conversation. `raw` is the
   * base64url-encoded RFC822 message; `threadId` keeps the draft in the original thread.
   * Body content lives only in `raw` — logging stays status-only via postJson.
   */
  async createDraft(input: {
    accessToken: string;
    raw: string;
    threadId: string;
  }): Promise<GmailCreatedDraft> {
    const json = await this.postJson<GmailCreatedDraft>(
      `${GMAIL_BASE}/users/me/drafts`,
      input.accessToken,
      { message: { raw: input.raw, threadId: input.threadId } },
      "gmail"
    );
    return { id: json.id };
  }

  /**
   * Send a Gmail message threaded into an existing conversation. `raw` is the
   * base64url-encoded RFC822 message. Destructive; callers must gate on explicit approval.
   */
  async sendMessage(input: {
    accessToken: string;
    raw: string;
    threadId?: string;
  }): Promise<GmailSentMessage> {
    const body = input.threadId ? { raw: input.raw, threadId: input.threadId } : { raw: input.raw };
    const json = await this.postJson<GmailSentMessage>(
      `${GMAIL_BASE}/users/me/messages/send`,
      input.accessToken,
      body,
      "gmail"
    );
    return { id: json.id, threadId: json.threadId };
  }

  async deleteEvent(input: {
    accessToken: string;
    calendarId?: string;
    eventId: string;
  }): Promise<{ deleted: "deleted" | "already-gone" }> {
    const calendarId = input.calendarId ?? "primary";
    const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.eventId)}`;
    try {
      await this.deleteVoid(url, input.accessToken, "calendar");
      return { deleted: "deleted" };
    } catch (error) {
      if (
        error instanceof GoogleApiError &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        return { deleted: "already-gone" };
      }
      throw error;
    }
  }

  private async deleteVoid(url: string, accessToken: string, api: string): Promise<void> {
    const response = await this.fetchFn(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (response.ok) return;
    // Log status only; NEVER embed the response body in Error.message —
    // handleRouteError propagates Error.message to HTTP responses.
    const reason = await extractGoogleErrorReason(response);
    this.logger.error({ statusCode: response.status, api, reason }, "Google API call failed");
    throw new GoogleApiError(`Google ${api} returned ${response.status}`, response.status, reason);
  }

  private async getJson<T>(url: string, accessToken: string, api: string): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      // Log status server-side only; NEVER embed the response body in Error.message —
      // handleRouteError propagates Error.message to HTTP responses (oauth.ts:122).
      const reason = await extractGoogleErrorReason(response);
      this.logger.error({ statusCode: response.status, api, reason }, "Google API call failed");
      throw new GoogleApiError(
        `Google ${api} returned ${response.status}`,
        response.status,
        reason
      );
    }
    return (await response.json()) as T;
  }

  private async postJson<T>(
    url: string,
    accessToken: string,
    body: unknown,
    api: string
  ): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      // Log status server-side only; NEVER embed the response body in Error.message —
      // handleRouteError propagates Error.message to HTTP responses (oauth.ts:122).
      const reason = await extractGoogleErrorReason(response);
      this.logger.error({ statusCode: response.status, api, reason }, "Google API call failed");
      throw new GoogleApiError(
        `Google ${api} returned ${response.status}`,
        response.status,
        reason
      );
    }
    return (await response.json()) as T;
  }

  private async patchJson<T>(
    url: string,
    accessToken: string,
    body: unknown,
    api: string
  ): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      // Log status server-side only; NEVER embed the response body in Error.message —
      // handleRouteError propagates Error.message to HTTP responses (oauth.ts:122).
      const reason = await extractGoogleErrorReason(response);
      this.logger.error({ statusCode: response.status, api, reason }, "Google API call failed");
      throw new GoogleApiError(
        `Google ${api} returned ${response.status}`,
        response.status,
        reason
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Partial update — only the fields in `patch` are sent, so untouched fields (location,
   * guests added by hand, etc.) are never clobbered. Uses the SAME externalEventId across the
   * call, never delete-then-create.
   */
  async patchEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string,
    patch: {
      readonly start?: { dateTime: string; timeZone: string };
      readonly end?: { dateTime: string; timeZone: string };
    }
  ): Promise<GoogleCalendarEvent> {
    return this.patchJson<GoogleCalendarEvent>(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      accessToken,
      patch,
      "calendar"
    );
  }
}
