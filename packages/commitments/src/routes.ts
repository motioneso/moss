import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { PgBoss } from "pg-boss";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { CommitmentResolutionVerifier } from "@moss/module-sdk";
import { sendJob, assertMetadataOnlyPayload } from "@moss/jobs";
import { CommitmentsRepository } from "./repository.js";
import { COMMITMENT_EXTRACTION_QUEUE } from "./manifest.js";
import type { CommitmentCandidateStatus, CommitmentSourceKind } from "./types.js";

export interface CommitmentsRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly boss: PgBoss;
  readonly repository?: CommitmentsRepository;
  readonly resolutionVerifier?: CommitmentResolutionVerifier;
}

export function registerCommitmentsRoutes(
  app: FastifyInstance,
  deps: CommitmentsRouteDependencies
): void {
  const repo = deps.repository ?? new CommitmentsRepository();

  // GET /api/commitments/candidates
  const candidatesQuerySchema = Type.Object({
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending_review"),
        Type.Literal("accepted"),
        Type.Literal("rejected"),
        Type.Literal("snoozed"),
        Type.Literal("expired"),
        Type.Literal("explicit_non_action")
      ])
    )
  });
  app.get(
    "/api/commitments/candidates",
    { schema: { querystring: candidatesQuerySchema, response: { 200: Type.Array(Type.Any()) } } },
    async (request) => {
      const accessContext = await deps.resolveAccessContext(request);
      const { status } = request.query as { status?: CommitmentCandidateStatus };
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const candidates = await repo.listCandidates(scopedDb, accessContext.actorUserId, status);
        return candidates.map(safeCandidate);
      });
    }
  );

  // GET /api/commitments/candidates/:id
  app.get(
    "/api/commitments/candidates/:id",
    { schema: { response: { 200: Type.Any() } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const candidate = await repo.getCandidate(scopedDb, accessContext.actorUserId, id);
        if (!candidate) throw Object.assign(new Error("Not found"), { statusCode: 404 });
        const evidence = await repo.getEvidenceForCandidate(scopedDb, id);
        return { ...safeCandidate(candidate), evidence };
      });
    }
  );

  // PATCH /api/commitments/candidates/:id/status
  const statusUpdateSchema = Type.Object({
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("rejected"),
      Type.Literal("snoozed"),
      Type.Literal("explicit_non_action")
    ]),
    snoozedUntil: Type.Optional(Type.String({ format: "date-time" }))
  });
  app.patch(
    "/api/commitments/candidates/:id/status",
    { schema: { body: statusUpdateSchema, response: { 200: Type.Any() } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      const body = request.body as { status: CommitmentCandidateStatus; snoozedUntil?: string };
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const candidate = await repo.updateStatus(
          scopedDb,
          accessContext.actorUserId,
          id,
          body.status,
          body.snoozedUntil ? new Date(body.snoozedUntil) : undefined
        );
        return safeCandidate(candidate);
      });
    }
  );

  // POST /api/commitments/candidates/:id/resolve
  const resolveSchema = Type.Object({ resolutionRef: Type.String({ minLength: 1 }) });
  app.post(
    "/api/commitments/candidates/:id/resolve",
    { schema: { body: resolveSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      const { resolutionRef } = request.body as { resolutionRef: string };

      if (!deps.resolutionVerifier) {
        return reply.code(503).send({ error: "Resolution verifier unavailable" });
      }

      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const verification = await deps.resolutionVerifier!.verifyResolutionRef(
          scopedDb,
          accessContext.actorUserId,
          resolutionRef
        );
        if (!verification.valid) {
          return reply
            .code(422)
            .send({ error: verification.reason ?? "Invalid resolution reference" });
        }
        const candidate = await repo.setResolutionRef(
          scopedDb,
          accessContext.actorUserId,
          id,
          resolutionRef
        );
        return safeCandidate(candidate);
      });
    }
  );

  // POST /api/commitments/candidates/:id/suppress
  const suppressSchema = Type.Object({ suppressedBy: Type.String({ minLength: 1 }) });
  app.post(
    "/api/commitments/candidates/:id/suppress",
    { schema: { body: suppressSchema, response: { 200: Type.Any() } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const accessContext = await deps.resolveAccessContext(request);
      const { suppressedBy } = request.body as { suppressedBy: string };
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const drivingCandidate = await repo.getCandidate(
          scopedDb,
          accessContext.actorUserId,
          suppressedBy
        );
        if (!drivingCandidate) {
          throw Object.assign(new Error("Suppressor not found"), { statusCode: 404 });
        }
        if (drivingCandidate.status !== "explicit_non_action") {
          throw Object.assign(new Error("Suppressor must be explicit_non_action"), {
            statusCode: 422
          });
        }
        const candidate = await repo.updateStatus(
          scopedDb,
          accessContext.actorUserId,
          id,
          "explicit_non_action"
        );
        return safeCandidate(candidate);
      });
    }
  );

  // POST /api/commitments/extract
  const extractSchema = Type.Object({
    sourceKind: Type.Union([Type.Literal("chat"), Type.Literal("email"), Type.Literal("notes")])
  });
  app.post(
    "/api/commitments/extract",
    { schema: { body: extractSchema, response: { 202: Type.Any() } } },
    async (request, reply) => {
      const accessContext = await deps.resolveAccessContext(request);
      const { sourceKind } = request.body as { sourceKind: CommitmentSourceKind };
      const idempotencyKey = `extract:${accessContext.actorUserId}:${sourceKind}`;
      const payload = { actorUserId: accessContext.actorUserId, sourceKind, idempotencyKey };
      assertMetadataOnlyPayload(payload);
      await sendJob(deps.boss, COMMITMENT_EXTRACTION_QUEUE, payload, {
        singletonKey: idempotencyKey
      });
      reply.status(202);
      return { queued: true };
    }
  );

  // GET /api/commitments/extraction-state
  app.get(
    "/api/commitments/extraction-state",
    { schema: { response: { 200: Type.Array(Type.Any()) } } },
    async (request) => {
      const accessContext = await deps.resolveAccessContext(request);
      return deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        const kinds: CommitmentSourceKind[] = ["chat", "email", "notes"];
        const states = await Promise.all(
          kinds.map((k) => repo.getExtractionState(scopedDb, accessContext.actorUserId, k))
        );
        return states
          .filter((s) => s !== null)
          .map((s) => ({
            sourceKind: s!.sourceKind,
            lastExtractedAt: s!.lastExtractedAt?.toISOString() ?? null,
            lastRunAt: s!.lastRunAt.toISOString()
          }));
      });
    }
  );
}

function safeCandidate(c: {
  resolutionRef: string | null;
  id: string;
  ownerUserId: string;
  candidateSignature: string;
  kind: string;
  title: string;
  dueLocalDate: string | null;
  counterpartyLabel: string | null;
  status: string;
  confidence: string;
  suggestedHandling: string | null;
  suppressedBy: string | null;
  sourceCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  snoozedUntil: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const { resolutionRef, ...rest } = c;
  return { ...rest, hasResolutionRef: resolutionRef !== null };
}
