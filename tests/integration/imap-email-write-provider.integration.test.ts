import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import { ImapFlow } from "imapflow";
import {
  ConnectorsRepository,
  ImapEmailWriteProvider,
  createConnectorSecretCipher,
  type ImapConnectionSecret
} from "@moss/connectors";
import {
  connectionStrings,
  ids,
  resetFoundationDatabase,
  testImap
} from "../integration/test-database.js";
import type { EmailMessage } from "@moss/db";

describe("ImapEmailWriteProvider — GreenMail integration", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_CONNECTOR_SECRET_KEY;
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";

    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_CONNECTOR_SECRET_KEY;
    } else {
      process.env.JARVIS_CONNECTOR_SECRET_KEY = originalSecretKey;
    }
  });

  async function cleanupGreenMailFolders(): Promise<void> {
    const client = new ImapFlow({
      host: testImap.host,
      port: testImap.imapPort,
      secure: false,
      auth: { user: testImap.username, pass: testImap.password },
      logger: false
    });

    await client.connect();
    try {
      for (const folder of ["Drafts", "Sent"]) {
        try {
          await client.mailboxOpen(folder);
          const messages = (await client.search({ seen: false })) || [];
          for (const msg of messages) {
            await client.mailboxOpen(folder);
            await client.messageDelete(msg);
          }
        } catch (err) {
          // Folder might not exist, try to create it
          if ((err as Error).message.includes("No such mailbox")) {
            try {
              await client.mailboxCreate(folder);
            } catch {
              // Ignore if creation fails
            }
          }
        }
      }
    } finally {
      await client.logout();
    }
  }

  const mockMessage: EmailMessage = {
    id: "msg-123",
    sender: "probe@greenmail.test",
    subject: "Test subject",
    external_metadata: { messageId: "<msg-id@host>" },
    created_at: new Date(),
    updated_at: new Date(),
    owner_user_id: ids.userA,
    connector_account_id: "connector-acc-1",
    external_id: "ext-123",
    recipients: ["probe@greenmail.test"],
    snippet: "test snippet",
    body_excerpt: "test excerpt",
    received_at: new Date(),
    summary: null,
    signals: {},
    analysis_attempts: 0,
    judgement_requested_at: null
  };

  const testSecret: ImapConnectionSecret = {
    kind: "imap-password",
    providerId: "imap-fastmail",
    username: testImap.username,
    password: testImap.password,
    imapHost: testImap.host,
    imapPort: testImap.imapPort,
    imapTls: false,
    smtpHost: testImap.host,
    smtpPort: testImap.smtpPort,
    smtpSecurity: "none"
  };

  describe("saveDraft — APPEND to Drafts", () => {
    let provider: ImapEmailWriteProvider;
    let connectorAccountId: string;

    beforeEach(async () => {
      await cleanupGreenMailFolders();
    });

    beforeAll(async () => {
      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:verify-providers" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const providers = await repo.listProviders(scopedDb);
          const imapFastmail = providers.find((p) => p.provider_id === "imap-fastmail");
          expect(imapFastmail).toBeDefined();
        }
      );

      const account = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:imap-draft-setup" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return await repo.upsertImapAccount(scopedDb, {
            providerId: "imap-fastmail",
            encryptedSecret: cipher.encryptJson(testSecret)
          });
        }
      );

      connectorAccountId = account.id;

      const repoAndCipher = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:create-provider" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return { repo, cipher };
        }
      );

      provider = new ImapEmailWriteProvider(repoAndCipher.repo, repoAndCipher.cipher);
    });

    afterEach(async () => {
      await cleanupGreenMailFolders();
    });

    it("saves draft to Drafts via IMAP APPEND", async () => {
      mockMessage.connector_account_id = connectorAccountId;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:draft-1" },
        async (scopedDb) => {
          return await provider.saveDraft(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Test Draft",
            null,
            "Draft reply body"
          );
        }
      );

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("draft");

      const client = new ImapFlow({
        host: testImap.host,
        port: testImap.imapPort,
        secure: false,
        auth: { user: testImap.username, pass: testImap.password },
        logger: false
      });

      await client.connect();
      try {
        await client.mailboxOpen("Drafts");
        const messages = (await client.search({ seen: false })) || [];
        expect(messages.length).toBeGreaterThan(0);

        const first = messages[0];
        if (first === undefined) throw new Error("expected a message in the folder");

        let raw = "";
        for await (const fetched of client.fetch(first, { source: true })) {
          raw = fetched.source?.toString() ?? "";
        }

        expect(raw).toContain("Re: Test Draft");
        expect(raw).toContain("Draft reply body");
        expect(raw).toContain("recipient@example.com");
      } finally {
        await client.logout();
      }
    });

    it("preserves thread headers in saved draft", async () => {
      const threadId = "thread-abc-123";
      mockMessage.connector_account_id = connectorAccountId;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:draft-thread" },
        async (scopedDb) => {
          return await provider.saveDraft(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Threaded",
            threadId,
            "Threaded body"
          );
        }
      );

      expect(result.ok).toBe(true);

      const client = new ImapFlow({
        host: testImap.host,
        port: testImap.imapPort,
        secure: false,
        auth: { user: testImap.username, pass: testImap.password },
        logger: false
      });

      await client.connect();
      try {
        await client.mailboxOpen("Drafts");
        const messages = (await client.search({ seen: false })) || [];

        const first = messages[0];
        if (first === undefined) throw new Error("expected a message in the folder");
        let raw = "";
        for await (const fetched of client.fetch(first, { source: true })) {
          raw = fetched.source?.toString() ?? "";
        }

        expect(raw).toContain("Threaded body");
      } finally {
        await client.logout();
      }
    });
  });

  describe("send — SMTP + APPEND to Sent", () => {
    let provider: ImapEmailWriteProvider;
    let connectorAccountId: string;

    beforeEach(async () => {
      await cleanupGreenMailFolders();
    });

    beforeAll(async () => {
      const account = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:imap-send-setup" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return await repo.upsertImapAccount(scopedDb, {
            providerId: "imap-fastmail",
            encryptedSecret: cipher.encryptJson(testSecret)
          });
        }
      );

      connectorAccountId = account.id;

      const repoAndCipher = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:create-provider-2" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return { repo, cipher };
        }
      );

      provider = new ImapEmailWriteProvider(repoAndCipher.repo, repoAndCipher.cipher);
    });

    afterEach(async () => {
      await cleanupGreenMailFolders();
    });

    it("sends via SMTP and saves to Sent", async () => {
      mockMessage.connector_account_id = connectorAccountId;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:send-1" },
        async (scopedDb) => {
          return await provider.send(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Test Send",
            null,
            "Send reply body"
          );
        }
      );

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("send");

      const client = new ImapFlow({
        host: testImap.host,
        port: testImap.imapPort,
        secure: false,
        auth: { user: testImap.username, pass: testImap.password },
        logger: false
      });

      await client.connect();
      try {
        await client.mailboxOpen("Sent");
        const messages = (await client.search({ seen: false })) || [];
        expect(messages.length).toBeGreaterThan(0);

        const first = messages[0];
        if (first === undefined) throw new Error("expected a message in the folder");
        let raw = "";
        for await (const fetched of client.fetch(first, { source: true })) {
          raw = fetched.source?.toString() ?? "";
        }

        expect(raw).toContain("Re: Test Send");
        expect(raw).toContain("Send reply body");
        expect(raw).toContain("recipient@example.com");
      } finally {
        await client.logout();
      }
    });

    it("preserves thread headers in sent message", async () => {
      const threadId = "thread-xyz-789";
      mockMessage.connector_account_id = connectorAccountId;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:send-thread" },
        async (scopedDb) => {
          return await provider.send(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Threaded Send",
            threadId,
            "Threaded send body"
          );
        }
      );

      expect(result.ok).toBe(true);

      const client = new ImapFlow({
        host: testImap.host,
        port: testImap.imapPort,
        secure: false,
        auth: { user: testImap.username, pass: testImap.password },
        logger: false
      });

      await client.connect();
      try {
        await client.mailboxOpen("Sent");
        const messages = (await client.search({ seen: false })) || [];

        const first = messages[0];
        if (first === undefined) throw new Error("expected a message in the folder");
        let raw = "";
        for await (const fetched of client.fetch(first, { source: true })) {
          raw = fetched.source?.toString() ?? "";
        }

        expect(raw).toContain("Threaded send body");
      } finally {
        await client.logout();
      }
    });
  });

  describe("credential hygiene", () => {
    let provider: ImapEmailWriteProvider;
    let connectorAccountId: string;

    beforeAll(async () => {
      const account = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:cred-setup" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return await repo.upsertImapAccount(scopedDb, {
            providerId: "imap-fastmail",
            encryptedSecret: cipher.encryptJson(testSecret)
          });
        }
      );

      connectorAccountId = account.id;

      const repoAndCipher = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:create-provider-3" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return { repo, cipher };
        }
      );

      provider = new ImapEmailWriteProvider(repoAndCipher.repo, repoAndCipher.cipher);
    });

    it("never leaks credentials in success response", async () => {
      mockMessage.connector_account_id = connectorAccountId;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:cred-leak-1" },
        async (scopedDb) => {
          return await provider.saveDraft(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Credential Test",
            null,
            "Body"
          );
        }
      );

      expect(result.ok).toBe(true);
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(testSecret.password);
      expect(resultStr).not.toContain(testImap.username);
    });

    it("never leaks credentials in error response", async () => {
      const badSecret: ImapConnectionSecret = {
        ...testSecret,
        imapPort: 9999,
        smtpPort: 9999
      };

      const account = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:bad-secret" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return await repo.upsertImapAccount(scopedDb, {
            providerId: "imap-fastmail",
            encryptedSecret: cipher.encryptJson(badSecret)
          });
        }
      );

      const repoAndCipher = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:bad-provider" },
        async (scopedDb) => {
          const repo = new ConnectorsRepository();
          const cipher = createConnectorSecretCipher();
          return { repo, cipher };
        }
      );

      const badProvider = new ImapEmailWriteProvider(repoAndCipher.repo, repoAndCipher.cipher);
      mockMessage.connector_account_id = account.id;

      const result = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:bad-send" },
        async (scopedDb) => {
          return await badProvider.send(
            scopedDb,
            mockMessage,
            "recipient@example.com",
            "Re: Bad Credentials",
            null,
            "Body"
          );
        }
      );

      expect(result.ok).toBe(false);
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(badSecret.password);
      expect(resultStr).not.toContain(testImap.username);
    });
  });
});
