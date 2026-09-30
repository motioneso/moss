import { describe, it, expect, vi } from "vitest";
import { GoogleEmailWriteProvider } from "@moss/connectors";
import { GoogleApiError, GoogleConnectError } from "@moss/connectors";
import type { DataContextDb, EmailMessage } from "@moss/db";

describe("GoogleEmailWriteProvider", () => {
  const mockGoogleService = {
    getFreshAccessToken: vi.fn()
  };

  const mockGoogleApiClient = {
    createDraft: vi.fn(),
    sendMessage: vi.fn()
  };

  const provider = new GoogleEmailWriteProvider(mockGoogleService, mockGoogleApiClient);
  const mockScopedDb = {} as unknown as DataContextDb;

  const mockMessage: EmailMessage = {
    id: "msg-123",
    sender: "sender@example.com",
    subject: "Test subject",
    external_metadata: { threadId: "thread-abc" },
    created_at: new Date(),
    updated_at: new Date(),
    owner_user_id: "user-123",
    connector_account_id: "acc-1",
    external_id: "ext-123",
    recipients: ["sender@example.com"],
    snippet: "test snippet",
    body_excerpt: "test excerpt",
    received_at: new Date(),
    summary: null,
    signals: {},
    analysis_attempts: 0,
    judgement_requested_at: null
  };

  it("returns success on valid draft save", async () => {
    mockGoogleService.getFreshAccessToken.mockResolvedValue("valid-token");
    mockGoogleApiClient.createDraft.mockResolvedValue(undefined);

    const result = await provider.saveDraft(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("draft");
    expect(mockGoogleApiClient.createDraft).toHaveBeenCalledWith({
      accessToken: "valid-token",
      raw: expect.any(String),
      threadId: "thread-abc"
    });
  });

  it("returns success on valid send", async () => {
    mockGoogleService.getFreshAccessToken.mockResolvedValue("valid-token");
    mockGoogleApiClient.sendMessage.mockResolvedValue(undefined);

    const result = await provider.send(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("send");
    expect(mockGoogleApiClient.sendMessage).toHaveBeenCalledWith({
      accessToken: "valid-token",
      raw: expect.any(String),
      threadId: "thread-abc"
    });
  });

  it("returns sanitized error when no threadId", async () => {
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

  it("returns sanitized error on auth failure", async () => {
    mockGoogleService.getFreshAccessToken.mockRejectedValue(
      new GoogleConnectError("No connection")
    );

    const result = await provider.send(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Connect Google in Settings first.");
    expect(result.mode).toBe("send");
  });

  it("returns sanitized error on token refresh failure", async () => {
    mockGoogleService.getFreshAccessToken.mockRejectedValue(new Error("Token expired"));

    const result = await provider.send(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Couldn't refresh your Google access — reconnect in Settings.");
    expect(result.mode).toBe("send");
  });

  it("returns sanitized error on upstream API failure", async () => {
    mockGoogleService.getFreshAccessToken.mockResolvedValue("valid-token");
    mockGoogleApiClient.sendMessage.mockRejectedValue(new GoogleApiError("API error", 500));

    const result = await provider.send(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Couldn't send your reply right now — try again.");
    expect(result.mode).toBe("send");
    expect(mockGoogleApiClient.sendMessage).toHaveBeenCalled();
  });

  it("never leaks credentials in result", async () => {
    mockGoogleService.getFreshAccessToken.mockResolvedValue("secret-token-123");
    mockGoogleApiClient.sendMessage.mockRejectedValue(new Error("Network error"));

    const result = await provider.send(
      mockScopedDb,
      mockMessage,
      "recipient@example.com",
      "Re: Test",
      "thread-abc",
      "Reply body"
    );

    expect(result.ok).toBe(false);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("secret-token-123");
  });
});
