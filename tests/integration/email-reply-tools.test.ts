import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { emailModuleManifest, EmailRepository } from "@moss/email";
import { buildEmailWriteService } from "@moss/chat";
import {
  ConnectorsRepository,
  createConnectorSecretCipher,
  featureGrantsPrefKey,
  GoogleApiClient,
  GoogleConnectionService,
  GoogleOAuthClient
} from "@moss/connectors";
import { PreferencesRepository } from "@moss/structured-state";
import type { MossActionPermissionTier } from "@moss/module-sdk";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { createCleanConversationFixture } from "./fixtures/clean-conversations.js";

/**
 * T11 — email reply agency, gateway-level acceptance (spec §8, plan #629).
 *
 * Exercises the real email manifest + real `buildEmailWriteService` (Gmail fetch faked) through
 * the AssistantToolGateway to prove the security-tier behaviours end to end:
 *   1. `email.draftReply` auto-executes when `email_drafts` is promoted to `trusted_auto`.
 *   2. `email.draftReply` confirms (emits a card) when the tier is `ask_each_time`.
 *   3. `email.sendReply` ALWAYS confirms — even when the (irrelevant) family tier is trusted_auto.
 *   4. The recipient is server-derived from the cached message, never from tool input.
 *   5. The composed reply body never lands in the persisted action row or the audit log.
 */

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

// The composed body carries a distinctive marker so any leak into a persisted row / audit row is
// caught by a substring check. It must NEVER appear anywhere durable.
const SECRET_BODY = "SECRET-REPLY-BODY-must-never-persist-9f3a";

const SENDER = "original.sender@example.test";
const THREAD_ID = "gmail-thread-abc123";

describe("email reply tools — gateway acceptance", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let conversations: Awaited<ReturnType<typeof createCleanConversationFixture>>;
  let repository: AiRepository;

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new AiRepository();
  });

  beforeEach(async () => {
    conversations = await createCleanConversationFixture(dataContext, [ids.userA, ids.userB]);
  });
  afterAll(async () => {
    await appDb.destroy();
  });

  // ── Seeding ────────────────────────────────────────────────────────────────

  async function seedGoogleAccount(ownerId: string, scopes: string[]): Promise<string> {
    const cipher = createConnectorSecretCipher();
    const repo = new ConnectorsRepository();
    const account = await dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "seed" },
      (scopedDb) =>
        repo.upsertGoogleAccount(scopedDb, {
          scopes,
          encryptedSecret: cipher.encryptJson({
            kind: "google-oauth",
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "atoken",
            refreshToken: "rtoken",
            tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
            grantedScopes: scopes
          })
        })
    );
    await dataContext.withDataContext({ actorUserId: ownerId, requestId: "seed-grants" }, (db) =>
      new PreferencesRepository().upsert(db, featureGrantsPrefKey(account.id), {
        email: true,
        calendar: true
      })
    );
    return account.id;
  }

  async function seedMessage(
    ownerId: string,
    accountId: string,
    opts: { externalId: string; subject: string; threadId?: string | null }
  ): Promise<string> {
    const row = await dataContext.withDataContext(
      { actorUserId: ownerId, requestId: "seed-msg" },
      (db) =>
        new EmailRepository().createCachedMessageForTest(db, {
          connectorAccountId: accountId,
          sender: SENDER,
          recipients: ["me@example.test"],
          subject: opts.subject,
          receivedAt: new Date("2026-06-30T12:00:00Z"),
          externalId: opts.externalId,
          externalMetadata: opts.threadId === null ? {} : { threadId: opts.threadId ?? THREAD_ID }
        })
    );
    return row.id;
  }

  // ── Faked Gmail write service (real buildEmailWriteService) ──────────────────

  type GmailCall = { kind: "draft" | "send"; raw: string; threadId: string };

  function buildEmailImpl() {
    const calls: GmailCall[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (url.includes("/users/me/drafts") && method === "POST") {
        calls.push({ kind: "draft", raw: body.message.raw, threadId: body.message.threadId });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "draft-1" }),
          text: async () => "{}"
        } as Response;
      }
      if (url.includes("/users/me/messages/send") && method === "POST") {
        calls.push({ kind: "send", raw: body.raw, threadId: body.threadId });
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "msg-1", threadId: body.threadId }),
          text: async () => "{}"
        } as Response;
      }
      // OAuth refresh (only if the seeded token were near expiry — it is not, but stay safe).
      if (url.includes("oauth2") || url.includes("token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "fresh-tok",
            expires_in: 3600,
            token_type: "Bearer",
            scope: GMAIL_MODIFY
          }),
          text: async () => ""
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;

    const cipher = createConnectorSecretCipher();
    const connectorsRepo = new ConnectorsRepository();
    const impl = buildEmailWriteService({
      emailRepository: new EmailRepository(),
      connectorsRepository: connectorsRepo,
      googleService: new GoogleConnectionService({
        repository: connectorsRepo,
        cipher,
        oauthClient: new GoogleOAuthClient({ fetchFn })
      }),
      googleApiClient: new GoogleApiClient({ fetchFn }),
      cipher,
      preferencesRepository: new PreferencesRepository()
    });
    return { impl, calls };
  }

  // ── Gateway harness ──────────────────────────────────────────────────────────

  function buildGateway(services: Record<string, unknown>, tier: MossActionPermissionTier) {
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: { chatSessionId: string; record: GatewaySessionRecord }[] = [];
    const family = emailModuleManifest.assistantActionFamilies![0];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [emailModuleManifest],
      repository,
      ...conversations.gatewayDependencies,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      toolServices: services,
      actionPolicy: () => ({
        getFamilyTier: async () => tier,
        getFamilyManifest: async () => family ?? null
      })
    });
    return { gateway, tokens, emitted };
  }

  async function waitForCard(
    emitted: { record: GatewaySessionRecord }[],
    toolName: string,
    timeoutMs = 5_000
  ): Promise<Extract<GatewaySessionRecord, { kind: "action_request" }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = emitted.find(
        (e): e is { record: Extract<GatewaySessionRecord, { kind: "action_request" }> } =>
          e.record.kind === "action_request" && e.record.toolName === toolName
      );
      if (hit) return hit.record;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timeout: no action_request for ${toolName}`);
  }

  function decodeMime(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf8");
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  it("draftReply auto-executes (no card) when email_drafts is promoted to trusted_auto", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [GMAIL_MODIFY]);
    const messageId = await seedMessage(ids.userA, accountId, {
      externalId: "msg-auto",
      subject: "Lunch Friday?"
    });
    const { impl, calls } = buildEmailImpl();
    const { gateway, tokens, emitted } = buildGateway({ emailWrite: impl }, "trusted_auto");
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "s-auto",
      allowedToolNames: null
    });

    const res = await gateway.callTool(token, "email.draftReply", {
      cacheMessageId: messageId,
      body: SECRET_BODY
    });

    expect(res.ok).toBe(true);
    // Auto path: no confirmation card was ever emitted.
    expect(emitted.some((e) => e.record.kind === "action_request")).toBe(false);
    // The Gmail draft was created, threaded, addressed to the server-derived sender.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("draft");
    expect(calls[0]!.threadId).toBe(THREAD_ID);
    const mime = decodeMime(calls[0]!.raw);
    expect(mime).toContain(`To: ${SENDER}`);
    expect(mime).toContain("Subject: Re: Lunch Friday?");

    // Audit records the auto approval; the body never rides the audit row.
    const audit = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "audit-auto" },
      (db) =>
        repository.listActionAuditLog(db, { since: new Date(Date.now() - 120_000), limit: 50 })
    );
    const row = audit.find((r) => r.tool_name === "email.draftReply");
    expect(row?.approval_mode).toBe("auto");
    expect(JSON.stringify(audit)).not.toContain(SECRET_BODY);
  });

  it("draftReply confirms (emits a card, holds execution) when tier is ask_each_time", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [GMAIL_MODIFY]);
    const messageId = await seedMessage(ids.userA, accountId, {
      externalId: "msg-confirm",
      subject: "Re: Budget"
    });
    const { impl, calls } = buildEmailImpl();
    const { gateway, tokens, emitted } = buildGateway({ emailWrite: impl }, "ask_each_time");
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "s-confirm",
      allowedToolNames: null
    });

    const call = gateway.callTool(token, "email.draftReply", {
      cacheMessageId: messageId,
      body: SECRET_BODY
    });

    const card = await waitForCard(emitted, "email.draftReply");
    // Held: nothing sent to Gmail until the user approves.
    expect(calls).toHaveLength(0);
    // The rich preview rode the live card (server-derived recipient/subject + composed body).
    expect(card.preview).toBeDefined();
    expect(card.preview?.to).toBe(SENDER);
    expect(card.preview?.subject).toBe("Re: Budget"); // already prefixed → idempotent
    expect(card.preview?.body).toBe(SECRET_BODY);

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    const res = await call;
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("draft");

    // The persisted action row keeps ONLY key names — never the composed body.
    const actions = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "rows-confirm" },
      (db) => repository.listAssistantActions(db)
    );
    const persisted = actions.find((a) => a.id === card.actionRequestId);
    expect(persisted).toBeDefined();
    expect(persisted!.input_summary).toStrictEqual({
      inputKeys: ["body", "cacheMessageId"],
      inputKeyCount: 2,
      truncated: false
    });
    expect(JSON.stringify(persisted)).not.toContain(SECRET_BODY);
  });

  it("sendReply ALWAYS confirms — even when the family tier is trusted_auto", async () => {
    // Ben's ruling, 2026-07-26 (#1263 Task 11) withdrew an earlier granted_at_install
    // classification for this tool and fixed the roster at confirm_always instead — this
    // assertion is what makes that manifest declaration, not just policy.ts, prove the guarantee.
    const sendReplyTool = emailModuleManifest.assistantTools?.find(
      (candidate) => candidate.name === "email.sendReply"
    );
    expect(sendReplyTool?.selfOperationGrant).toBe("confirm_always");
    expect(sendReplyTool?.actionFamilyId).toBeUndefined();
    expect(sendReplyTool?.executionPolicy).toBeUndefined();

    const accountId = await seedGoogleAccount(ids.userA, [GMAIL_MODIFY]);
    const messageId = await seedMessage(ids.userA, accountId, {
      externalId: "msg-send",
      subject: "Invoice"
    });
    const { impl, calls } = buildEmailImpl();
    // trusted_auto has NO effect on a destructive tool: policy.ts confirms it regardless.
    const { gateway, tokens, emitted } = buildGateway({ emailWrite: impl }, "trusted_auto");
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "s-send",
      allowedToolNames: null
    });

    const call = gateway.callTool(token, "email.sendReply", {
      cacheMessageId: messageId,
      body: SECRET_BODY
    });

    const card = await waitForCard(emitted, "email.sendReply");
    expect(calls).toHaveLength(0); // never auto-sends

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    const res = await call;
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("send");
    expect(calls[0]!.threadId).toBe(THREAD_ID);
    expect(decodeMime(calls[0]!.raw)).toContain(`To: ${SENDER}`);
  });

  it("recipient is server-derived: a hostile `to` in tool input is ignored", async () => {
    const accountId = await seedGoogleAccount(ids.userA, [GMAIL_MODIFY]);
    const messageId = await seedMessage(ids.userA, accountId, {
      externalId: "msg-hostile",
      subject: "Hello"
    });
    const { impl, calls } = buildEmailImpl();
    const { gateway, tokens } = buildGateway({ emailWrite: impl }, "trusted_auto");
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "s-hostile",
      allowedToolNames: null
    });

    const res = await gateway.callTool(token, "email.draftReply", {
      cacheMessageId: messageId,
      body: SECRET_BODY,
      // These extra fields are NOT in the schema and must never influence addressing.
      to: "attacker@evil.test",
      recipient: "attacker@evil.test",
      threadId: "attacker-thread"
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const mime = decodeMime(calls[0]!.raw);
    expect(mime).toContain(`To: ${SENDER}`);
    expect(mime).not.toContain("attacker@evil.test");
    expect(calls[0]!.threadId).toBe(THREAD_ID);
    expect(calls[0]!.threadId).not.toBe("attacker-thread");
  });
});
