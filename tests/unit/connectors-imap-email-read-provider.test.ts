import { describe, expect, it } from "vitest";

import { ImapEmailReadProvider } from "../../packages/connectors/src/imap-email-read-provider.js";
import type { ImapConnectionSecret } from "../../packages/connectors/src/imap-secret.js";

const SECRET: ImapConnectionSecret = {
  kind: "imap-password",
  providerId: "imap-proton",
  username: "user@proton.local",
  password: "secret",
  imapHost: "127.0.0.1",
  imapPort: 1143,
  imapTls: false,
  smtpHost: "127.0.0.1",
  smtpPort: 1025,
  smtpSecurity: "none"
};

const RAW_MESSAGE = [
  "From: Alice <alice@example.com>",
  "To: user@proton.local",
  "Subject: Test subject",
  "Date: Mon, 01 Jun 2026 12:00:00 +0000",
  "",
  "Hello world"
].join("\r\n");

function makeFakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connect: async () => undefined,
    logout: async () => undefined,
    close: async () => undefined,
    list: async () => [{ path: "INBOX" }, { path: "Archive" }],
    mailboxOpen: async () => ({ uidValidity: 1719700000n, exists: 1 }),
    search: async () => [1, 2],
    fetchOne: async () => ({ uid: 1, source: Buffer.from(RAW_MESSAGE) }),
    ...overrides
  };
}

describe("ImapEmailReadProvider", () => {
  it("lists real mailbox paths via list()", async () => {
    const provider = new ImapEmailReadProvider(() => makeFakeClient() as never);
    const folders = await provider.listFolders(SECRET);
    expect(folders).toEqual(["INBOX", "Archive"]);
  });

  it("encodes folder+uidValidity+uid into each key's id", async () => {
    const provider = new ImapEmailReadProvider(() => makeFakeClient() as never);
    const keys = await provider.listMessageKeys(SECRET, "INBOX");
    expect(keys).toEqual([
      { folder: "INBOX", id: "imap:INBOX:1719700000:1" },
      { folder: "INBOX", id: "imap:INBOX:1719700000:2" }
    ]);
  });

  it("fetches and parses a message body/headers by decoding the key", async () => {
    const provider = new ImapEmailReadProvider(() => makeFakeClient() as never);
    const parsed = await provider.getMessage(SECRET, {
      folder: "INBOX",
      id: "imap:INBOX:1719700000:1"
    });
    expect(parsed.externalId).toBe("imap:INBOX:1719700000:1");
    expect(parsed.subject).toBe("Test subject");
    expect(parsed.from).toContain("alice@example.com");
    expect(parsed.body).toContain("Hello world");
  });

  it("fills the preview from the body already fetched (#2314)", async () => {
    // Plain mail carries no provider preview, so the closer reader used to see subject only.
    // The preview is derived here from the body this call already parses, never re-fetched.
    const provider = new ImapEmailReadProvider(() => makeFakeClient() as never);
    const parsed = await provider.getMessage(SECRET, {
      folder: "INBOX",
      id: "imap:INBOX:1719700000:1"
    });
    expect(parsed.snippet).toBe("Hello world");
  });

  it("caps the preview and flattens a multi-line body to one line (#2314)", async () => {
    const longLine = "x".repeat(800);
    const raw = [
      "From: Alice <alice@example.com>",
      "To: user@proton.local",
      "Subject: Long one",
      "Date: Mon, 01 Jun 2026 12:00:00 +0000",
      "",
      "line one",
      "line two",
      longLine
    ].join("\r\n");
    const provider = new ImapEmailReadProvider(
      () =>
        makeFakeClient({ fetchOne: async () => ({ uid: 1, source: Buffer.from(raw) }) }) as never
    );
    const parsed = await provider.getMessage(SECRET, {
      folder: "INBOX",
      id: "imap:INBOX:1719700000:1"
    });
    expect(parsed.snippet).toBe(`line one line two ${longLine}`.slice(0, 500));
  });

  it("derives the preview from an HTML-only body when no plain part exists (#2314)", async () => {
    const raw = [
      "From: Alice <alice@example.com>",
      "To: user@proton.local",
      "Subject: HTML only",
      "Date: Mon, 01 Jun 2026 12:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<html><body><p>Your parcel</p><p>arrived</p></body></html>"
    ].join("\r\n");
    const provider = new ImapEmailReadProvider(
      () =>
        makeFakeClient({ fetchOne: async () => ({ uid: 1, source: Buffer.from(raw) }) }) as never
    );
    const parsed = await provider.getMessage(SECRET, {
      folder: "INBOX",
      id: "imap:INBOX:1719700000:1"
    });
    expect(parsed.snippet).toContain("Your parcel");
    expect(parsed.snippet).not.toContain("<p>");
  });

  it("throws on a malformed key rather than silently fetching the wrong message", async () => {
    const provider = new ImapEmailReadProvider(() => makeFakeClient() as never);
    await expect(
      provider.getMessage(SECRET, { folder: "INBOX", id: "not-an-imap-key" })
    ).rejects.toThrow();
  });
});
