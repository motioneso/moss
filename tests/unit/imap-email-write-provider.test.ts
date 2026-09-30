import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DataContextDb, EmailMessage } from "@moss/db";
import { ImapEmailWriteProvider } from "@moss/connectors";
import type { ConnectorSecretCipher, ConnectorsRepository } from "@moss/connectors";

/** The private methods the tests stub via vi.spyOn — not part of the public type. */
type ImapProviderInternals = {
  appendToImapFolder: (secret: unknown, folder: string, message: Buffer) => Promise<void>;
  sendViaSmtp: (secret: unknown, to: string, message: Buffer) => Promise<void>;
};

describe("ImapEmailWriteProvider", () => {
  const mockRepository = {
    getActiveImapAccountSecret: vi.fn()
  };

  const mockCipher = {
    decryptJson: vi.fn()
  };

  let provider: ImapEmailWriteProvider;
  const mockScopedDb = {} as unknown as DataContextDb;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ImapEmailWriteProvider(
      mockRepository as unknown as Pick<ConnectorsRepository, "getActiveImapAccountSecret">,
      mockCipher as unknown as ConnectorSecretCipher
    );
  });

  const mockMessage: EmailMessage = {
    id: "msg-123",
    sender: "sender@example.com",
    subject: "Test subject",
    external_metadata: { messageId: "<msg-id@host>" },
    created_at: new Date(),
    updated_at: new Date(),
    owner_user_id: "user-123",
    connector_account_id: "connector-acc-1",
    external_id: "ext-123",
    recipients: ["sender@example.com"],
    snippet: "test snippet",
    body_excerpt: "test excerpt",
    received_at: new Date(),
    summary: null,
    signals: {},
    analysis_attempts: 0
  };

  const mockSecret = {
    kind: "imap-password" as const,
    providerId: "provider-123",
    username: "user@example.com",
    password: "app-password-123",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecurity: "starttls" as const
  };

  describe("repository and cipher integration", () => {
    it("looks up secret by connector account ID", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockResolvedValue(undefined);

      await provider.saveDraft(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(mockRepository.getActiveImapAccountSecret).toHaveBeenCalledWith(
        mockScopedDb,
        "connector-acc-1"
      );
      appendSpy.mockRestore();
    });

    it("decrypts secret with cipher", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockResolvedValue(undefined);

      await provider.saveDraft(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(mockCipher.decryptJson).toHaveBeenCalledWith("encrypted");
      appendSpy.mockRestore();
    });

    it("returns sanitized error when no secret found", async () => {
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(null);

      const result = await provider.send(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Couldn't send your reply right now — try again.");
      expect(result.mode).toBe("send");
    });

    it("returns sanitized error on secret decryption failure", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const result = await provider.send(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Couldn't send your reply right now — try again.");
      expect(result.mode).toBe("send");
    });

    it("never leaks credentials in result", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockRejectedValue(new Error("Connection failed"));

      const result = await provider.saveDraft(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(false);
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("app-password-123");
      expect(resultStr).not.toContain("user@example.com");
      expect(resultStr).not.toContain("imap.example.com");
      appendSpy.mockRestore();
    });
  });

  describe("saveDraft orchestration", () => {
    it("returns success on valid draft save", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockResolvedValue(undefined);

      const result = await provider.saveDraft(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("draft");
      expect(appendSpy).toHaveBeenCalledWith(mockSecret, "Drafts", expect.any(Buffer));
      appendSpy.mockRestore();
    });

    it("returns sanitized error on IMAP append failure", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockRejectedValue(new Error("IMAP error"));

      const result = await provider.saveDraft(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Couldn't send your reply right now — try again.");
      expect(result.mode).toBe("draft");
      appendSpy.mockRestore();
    });
  });

  describe("send orchestration", () => {
    it("returns success on valid send", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const smtpSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "sendViaSmtp")
        .mockResolvedValue(undefined);
      const appendSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "appendToImapFolder")
        .mockResolvedValue(undefined);

      const result = await provider.send(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("send");
      expect(smtpSpy).toHaveBeenCalledWith(mockSecret, "recipient@example.com", expect.any(Buffer));
      expect(appendSpy).toHaveBeenCalledWith(mockSecret, "Sent", expect.any(Buffer));
      smtpSpy.mockRestore();
      appendSpy.mockRestore();
    });

    it("returns sanitized error on SMTP failure", async () => {
      const storedSecret = { encryptedSecret: "encrypted" };
      mockRepository.getActiveImapAccountSecret.mockResolvedValue(storedSecret);
      mockCipher.decryptJson.mockReturnValue(mockSecret);

      const smtpSpy = vi
        .spyOn(provider as unknown as ImapProviderInternals, "sendViaSmtp")
        .mockRejectedValue(new Error("SMTP timeout"));

      const result = await provider.send(
        mockScopedDb,
        mockMessage,
        "recipient@example.com",
        "Re: Test",
        null,
        "Reply body"
      );

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Couldn't send your reply right now — try again.");
      expect(result.mode).toBe("send");
      smtpSpy.mockRestore();
    });
  });
});
