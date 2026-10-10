import {
  buildNewMessageMime,
  buildReplyMime,
  replyThreadHeaders,
  type EmailWriteProvider,
  type EmailWriteResult,
  type NewEmailInput
} from "@moss/email";
import type { DataContextDb, EmailMessage } from "@moss/db";
import {
  GoogleApiError,
  GoogleConnectError,
  type GoogleApiClient,
  type GoogleConnectionService
} from "@moss/connectors";

const MSG_NO_CONNECTION = "Connect Google in Settings first.";
const MSG_REFRESH_FAILED = "Couldn't refresh your Google access — reconnect in Settings.";
const MSG_UPSTREAM_FAILED = "Couldn't send your reply right now — try again.";

/**
 * Gmail implementation of EmailWriteProvider. Wraps GoogleApiClient draft/send
 * operations with provider-agnostic error handling. Credentials (access tokens) are
 * fetched from the database but never serialized into responses/logs/payloads/prompts.
 */
export class GoogleEmailWriteProvider implements EmailWriteProvider {
  constructor(
    private readonly googleService: Pick<GoogleConnectionService, "getFreshAccessToken">,
    private readonly googleApiClient: Pick<GoogleApiClient, "createDraft" | "sendMessage">
  ) {}

  async saveDraft(
    scopedDb: DataContextDb,
    message: EmailMessage,
    to: string,
    subject: string,
    threadId: string | null,
    body: string
  ): Promise<EmailWriteResult> {
    return this.run(scopedDb, "draft", message, to, subject, threadId, body);
  }

  async send(
    scopedDb: DataContextDb,
    message: EmailMessage,
    to: string,
    subject: string,
    threadId: string | null,
    body: string
  ): Promise<EmailWriteResult> {
    return this.run(scopedDb, "send", message, to, subject, threadId, body);
  }

  async sendNew(scopedDb: DataContextDb, input: NewEmailInput): Promise<EmailWriteResult> {
    const raw = buildNewMessageMime(input);

    let accessToken: string;
    try {
      accessToken = await this.googleService.getFreshAccessToken(scopedDb);
    } catch (error) {
      return {
        ok: false,
        mode: "send",
        message: error instanceof GoogleConnectError ? MSG_NO_CONNECTION : MSG_REFRESH_FAILED
      };
    }

    try {
      await this.googleApiClient.sendMessage({ accessToken, raw });
      return { ok: true, mode: "send" };
    } catch {
      return { ok: false, mode: "send", message: MSG_UPSTREAM_FAILED };
    }
  }

  private async run(
    scopedDb: DataContextDb,
    mode: "draft" | "send",
    message: EmailMessage,
    to: string,
    subject: string,
    threadId: string | null,
    body: string
  ): Promise<EmailWriteResult> {
    if (!threadId) {
      return { ok: false, mode, message: MSG_UPSTREAM_FAILED };
    }

    const raw = buildReplyMime({ to, subject, body, ...replyThreadHeaders(message) });

    let accessToken: string;
    try {
      accessToken = await this.googleService.getFreshAccessToken(scopedDb);
    } catch (error) {
      return {
        ok: false,
        mode,
        message: error instanceof GoogleConnectError ? MSG_NO_CONNECTION : MSG_REFRESH_FAILED
      };
    }

    try {
      if (mode === "draft") {
        await this.googleApiClient.createDraft({ accessToken, raw, threadId });
      } else {
        await this.googleApiClient.sendMessage({ accessToken, raw, threadId });
      }
    } catch (error) {
      if (error instanceof GoogleApiError || error instanceof GoogleConnectError) {
        return { ok: false, mode, message: MSG_UPSTREAM_FAILED };
      }
      return { ok: false, mode, message: MSG_UPSTREAM_FAILED };
    }

    return { ok: true, mode };
  }
}
