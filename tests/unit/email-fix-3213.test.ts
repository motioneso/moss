import { describe, expect, it, vi } from "vitest";

import type { DataContextDb, EmailMessage } from "@moss/db";
import { buildReplyMime, replyThreadHeaders, selectOwnAddresses } from "@moss/email";
import { ImapEmailWriteProvider } from "@moss/connectors";
import type { ConnectorSecretCipher, ConnectorsRepository } from "@moss/connectors";
import { cachedEmailInput } from "../../packages/connectors/src/google-sync-phases.js";
import { parseEmail } from "../../packages/connectors/src/email-extract.js";
import { replyThreadingMetadata } from "../../packages/connectors/src/reply-threading.js";
import { buildChatToolServices } from "../../packages/chat/src/gateway-services.js";

type Internals = {
  appendToImapFolder: (secret: unknown, folder: string, message: Buffer) => Promise<void>;
  sendViaSmtp: (secret: unknown, to: string, message: Buffer) => Promise<void>;
};

const secret = {
  kind: "imap-password",
  providerId: "p",
  username: "me@example.com",
  password: "pw",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapTls: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecurity: "starttls"
};

const message = {
  id: "m1",
  connector_account_id: "acct",
  sender: "alice@example.com",
  subject: "Lunch",
  external_metadata: { messageId: "<b@x>", references: ["<a@x>"] }
} as unknown as EmailMessage;

const db = {} as DataContextDb;

function makeProvider() {
  const repo = { getActiveImapAccountSecret: vi.fn(async () => ({ encryptedSecret: "e" })) };
  const cipher = { decryptJson: vi.fn(() => secret) };
  return new ImapEmailWriteProvider(
    repo as unknown as Pick<ConnectorsRepository, "getActiveImapAccountSecret">,
    cipher as unknown as ConnectorSecretCipher
  );
}

describe("AIRC-002: a failed Sent copy does not undo an accepted send", () => {
  it("reply still reports sent when the Sent copy fails", async () => {
    const provider = makeProvider();
    const smtp = vi
      .spyOn(provider as unknown as Internals, "sendViaSmtp")
      .mockResolvedValue(undefined);
    vi.spyOn(provider as unknown as Internals, "appendToImapFolder").mockRejectedValue(
      new Error("imap down")
    );
    const result = await provider.send(db, message, "a@x.com", "Re: Lunch", null, "hi");
    expect(smtp).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, mode: "send" });
  });

  it("new message still reports sent when the Sent copy fails", async () => {
    const provider = makeProvider();
    vi.spyOn(provider as unknown as Internals, "sendViaSmtp").mockResolvedValue(undefined);
    vi.spyOn(provider as unknown as Internals, "appendToImapFolder").mockRejectedValue(
      new Error("imap down")
    );
    const result = await provider.sendNew(db, {
      connectorAccountId: "acct",
      to: "a@x.com",
      subject: "s",
      body: "b"
    });
    expect(result).toEqual({ ok: true, mode: "send" });
  });

  it("still reports failure when the send itself fails", async () => {
    const provider = makeProvider();
    vi.spyOn(provider as unknown as Internals, "sendViaSmtp").mockRejectedValue(new Error("smtp"));
    const append = vi
      .spyOn(provider as unknown as Internals, "appendToImapFolder")
      .mockResolvedValue(undefined);
    const result = await provider.send(db, message, "a@x.com", "Re: Lunch", null, "hi");
    expect(result.ok).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});

describe("AIRC-013: chat builds the email write service only with the connector cipher", () => {
  const base = {
    googleConnectionService: {} as never,
    googleApiClient: {} as never,
    connectorsRepository: {} as never
  };

  it("includes it when the cipher is supplied", () => {
    const services = buildChatToolServices({ ...base, cipher: {} as ConnectorSecretCipher });
    expect(services.emailWrite).toBeDefined();
  });

  it("omits it, so the tools fail closed, when the cipher is missing", () => {
    expect(buildChatToolServices(base).emailWrite).toBeUndefined();
  });
});

describe("DOM-038: replies carry the headers that join the conversation", () => {
  it("emits In-Reply-To and References from the original message", () => {
    const raw = Buffer.from(
      buildReplyMime({
        to: "a@x.com",
        subject: "Re: Lunch",
        body: "hi",
        ...replyThreadHeaders(message)
      }),
      "base64url"
    ).toString("utf8");
    expect(raw).toContain("In-Reply-To: <b@x>\n");
    expect(raw).toContain("References: <a@x> <b@x>\n");
  });

  it("the IMAP provider puts them in the saved draft", async () => {
    const provider = makeProvider();
    const append = vi
      .spyOn(provider as unknown as Internals, "appendToImapFolder")
      .mockResolvedValue(undefined);
    await provider.saveDraft(db, message, "a@x.com", "Re: Lunch", null, "hi");
    const saved = (append.mock.calls[0]?.[2] as Buffer).toString("utf8");
    expect(saved).toContain("In-Reply-To: <b@x>");
    expect(saved).toContain("References: <a@x> <b@x>");
  });

  it("omits the headers when the original has no Message-ID", () => {
    const bare = { ...message, external_metadata: {} } as EmailMessage;
    const raw = Buffer.from(
      buildReplyMime({ to: "a@x.com", subject: "s", body: "b", ...replyThreadHeaders(bare) }),
      "base64url"
    ).toString("utf8");
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
  });
});

describe("DOM-040: a frequent co-recipient is not the owner", () => {
  it("drops an address far less frequent than the owner's", () => {
    const counts = new Map([
      ["me@example.com", 480],
      ["colleague@example.com", 110]
    ]);
    expect(selectOwnAddresses(counts, 500)).toEqual(["me@example.com"]);
  });

  it("drops a colleague on well over half as many messages as the owner", () => {
    const counts = new Map([
      ["me@example.com", 400],
      ["colleague@example.com", 260]
    ]);
    expect(selectOwnAddresses(counts, 500)).toEqual(["me@example.com"]);
  });

  it("keeps an alias nearly as busy as the main address", () => {
    const counts = new Map([
      ["me@example.com", 300],
      ["alias@example.com", 260],
      ["colleague@example.com", 100]
    ]);
    expect(selectOwnAddresses(counts, 500).sort()).toEqual(["alias@example.com", "me@example.com"]);
  });

  it("returns nothing for an empty cache", () => {
    expect(selectOwnAddresses(new Map(), 0)).toEqual([]);
  });
});

describe("DOM-038: threading ids survive sync", () => {
  const header = (name: string, value: string) => ({ name, value });
  const gmailMessage = {
    id: "g1",
    threadId: "t1",
    internalDate: "1700000000000",
    payload: {
      headers: [
        header("From", "alice@example.com"),
        header("To", "me@example.com"),
        header("Subject", "Lunch"),
        header("Message-ID", "<b@x>"),
        header("References", "<a@x>\r\n <root@x>")
      ]
    }
  };

  it("a fetched Gmail message is saved with its ids and replies thread from the saved row", () => {
    const parsed = parseEmail(gmailMessage as never);
    const row = cachedEmailInput("acct", parsed, { summary: null, signals: {} });
    const cached = { ...message, external_metadata: row.externalMetadata } as EmailMessage;
    const { inReplyTo, references } = replyThreadHeaders(cached);
    expect(inReplyTo).toBe("<b@x>");
    expect(references).toEqual(["<a@x>", "<root@x>", "<b@x>"]);
  });

  it("an IMAP message's saved metadata carries its ids", () => {
    const meta = replyThreadingMetadata({
      messageId: "<b@x>",
      references: ["<a@x>"]
    } as never);
    expect(meta).toEqual({ messageId: "<b@x>", references: ["<a@x>"] });
    expect(replyThreadingMetadata({} as never)).toEqual({});
  });
});
