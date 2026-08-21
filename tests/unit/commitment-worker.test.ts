import { describe, it, expect, vi, afterEach } from "vitest";
import type { Job, PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import { AiRepository, AiSecretCipher, HttpApiAdapter, createAiSecretCipher } from "@moss/ai";
import { registerCommitmentExtractionWorker } from "@moss/commitments/workers";
import type { CommitmentExtractionWorkerDeps } from "@moss/commitments/workers";
import { enqueueCommitmentExtraction } from "@moss/commitments/jobs";
import type { CommitmentExtractionJobPayload } from "@moss/commitments/jobs";
import { CommitmentsRepository } from "@moss/commitments";

const model = {
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "model-1"
} as const;

afterEach(() => vi.restoreAllMocks());

describe("commitment worker exports", () => {
  it("exports registerCommitmentExtractionWorker", () => {
    expect(typeof registerCommitmentExtractionWorker).toBe("function");
  });

  it("exports enqueueCommitmentExtraction", () => {
    expect(typeof enqueueCommitmentExtraction).toBe("function");
  });
});

function dataContext(): DataContextRunner {
  return {
    withDataContext: async (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) =>
      work({} as DataContextDb)
  } as DataContextRunner;
}

async function captureHandler(
  deps: Omit<CommitmentExtractionWorkerDeps, "aiRepository" | "cipher" | "repository"> &
    Partial<Pick<CommitmentExtractionWorkerDeps, "aiRepository" | "cipher" | "repository">>
): Promise<(jobs: Job<CommitmentExtractionJobPayload>[]) => Promise<void>> {
  let handler: ((jobs: Job<CommitmentExtractionJobPayload>[]) => Promise<void>) | undefined;
  const boss = {
    work: async (_queue: string, _options: unknown, fn: typeof handler) => {
      handler = fn;
      return "work-id";
    }
  } as unknown as PgBoss;

  await registerCommitmentExtractionWorker(boss, dataContext(), {
    aiRepository: deps.aiRepository ?? new AiRepository(),
    cipher: deps.cipher ?? createAiSecretCipher(),
    repository: deps.repository ?? new CommitmentsRepository(),
    providers: deps.providers,
    logger: deps.logger
  });

  if (!handler) throw new Error("worker did not register a handler");
  return handler;
}

function job(): Job<CommitmentExtractionJobPayload> {
  return {
    id: "job-1",
    data: {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      sourceKind: "chat",
      idempotencyKey: "chat:user-1"
    }
  } as unknown as Job<CommitmentExtractionJobPayload>;
}

describe("registerCommitmentExtractionWorker warnings", () => {
  it("warns and stops when no provider matches the source kind", async () => {
    const warn = vi.fn();
    const upsertCandidate = vi.fn();
    const addEvidenceRow = vi.fn();
    const handler = await captureHandler({
      providers: [],
      logger: { warn },
      repository: {
        upsertCandidate,
        addEvidenceRow
      } as unknown as CommitmentsRepository
    });

    await handler([job()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { event: "commitment-extraction-source-provider-missing", sourceKind: "chat" },
      "commitment extraction: source provider missing"
    );
    expect(upsertCandidate).not.toHaveBeenCalled();
    expect(addEvidenceRow).not.toHaveBeenCalled();
  });

  it("warns when no economy summarization model is configured", async () => {
    const warn = vi.fn();
    vi.spyOn(AiRepository.prototype, "selectModelForCapability").mockResolvedValue(null as never);

    const handler = await captureHandler({
      providers: [{ sourceKind: "chat", getTextBoundaries: vi.fn() }],
      logger: { warn }
    });

    await handler([job()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { event: "commitment-extraction-no-model", sourceKind: "chat" },
      "commitment extraction: no configured economy summarization model"
    );
  });

  it("warns when the selected provider's encrypted credential is missing", async () => {
    const warn = vi.fn();
    vi.spyOn(AiRepository.prototype, "selectModelForCapability").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      encrypted_credential: null
    } as never);

    const handler = await captureHandler({
      providers: [{ sourceKind: "chat", getTextBoundaries: vi.fn() }],
      logger: { warn }
    });

    await handler([job()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { event: "commitment-extraction-credential-missing", sourceKind: "chat" },
      "commitment extraction: selected provider or encrypted credential missing"
    );
  });

  it("warns when the decrypted credential is invalid", async () => {
    const warn = vi.fn();
    vi.spyOn(AiRepository.prototype, "selectModelForCapability").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      encrypted_credential: { ciphertext: "sealed" }
    } as never);
    vi.spyOn(AiSecretCipher.prototype, "decryptJson").mockReturnValue({ notAnApiKey: true });

    const handler = await captureHandler({
      providers: [{ sourceKind: "chat", getTextBoundaries: vi.fn() }],
      logger: { warn }
    });

    await handler([job()]);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      { event: "commitment-extraction-credential-invalid", sourceKind: "chat" },
      "commitment extraction: decrypted credential invalid"
    );
  });

  it("extracts and stores candidates on the happy path without warning", async () => {
    const warn = vi.fn();
    vi.spyOn(AiRepository.prototype, "selectModelForCapability").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      encrypted_credential: { ciphertext: "sealed" },
      base_url: null
    } as never);
    vi.spyOn(AiSecretCipher.prototype, "decryptJson").mockReturnValue({ apiKey: "secret-key" });
    vi.spyOn(HttpApiAdapter.prototype, "generateChat").mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            kind: "promise",
            title: "Send the report",
            dueLocalDate: "2026-08-25",
            counterpartyLabel: "Ben",
            evidenceExcerpt: "I'll send the report by Tuesday",
            confidence: "high"
          }
        ]
      })
    });

    const getTextBoundaries = vi.fn().mockResolvedValue([
      {
        text: "I'll send the report by Tuesday",
        occurredAt: "2026-08-20T00:00:00.000Z",
        sourceRef: "msg-1",
        sourceVersion: 1
      }
    ]);
    const upsertCandidate = vi.fn().mockResolvedValue({ id: "candidate-1" });
    const addEvidenceRow = vi.fn().mockResolvedValue(true);
    const upsertExtractionState = vi.fn().mockResolvedValue(undefined);

    const handler = await captureHandler({
      providers: [{ sourceKind: "chat", getTextBoundaries }],
      logger: { warn },
      repository: {
        getExtractionState: vi.fn().mockResolvedValue(null),
        upsertCandidate,
        addEvidenceRow,
        upsertExtractionState
      } as unknown as CommitmentsRepository
    });

    await handler([job()]);

    expect(warn).not.toHaveBeenCalled();
    expect(upsertCandidate).toHaveBeenCalledOnce();
    expect(addEvidenceRow).toHaveBeenCalledOnce();
    expect(upsertExtractionState).toHaveBeenCalledOnce();
  });

  it("does not throw when no logger is supplied", async () => {
    const handler = await captureHandler({
      providers: []
    });

    await expect(handler([job()])).resolves.toBeUndefined();
  });
});
