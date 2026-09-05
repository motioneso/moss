export {
  commitmentsModuleManifest,
  commitmentsModuleSqlMigrationDirectory,
  COMMITMENTS_MODULE_ID,
  COMMITMENT_EXTRACTION_QUEUE,
  COMMITMENT_EMAIL_JUDGEMENT_QUEUE
} from "./manifest.js";

export {
  judgeEmailThread,
  registerEmailThreadJudgementWorker,
  type EmailJudgementWorkerDeps,
  type EmailThreadJudgementResult
} from "./email-judgement-worker.js";
export { enqueueEmailThreadJudgement, type EmailThreadJudgementJobPayload } from "./jobs.js";
export { EMAIL_JUDGEMENT_SERVICE, EMAIL_JUDGEMENT_SCHEMA } from "./email-judgement.js";

export { CommitmentsRepository } from "./repository.js";

export type {
  CommitmentCandidateKind,
  CommitmentCandidateStatus,
  CommitmentSuggestedHandling,
  CommitmentSourceKind,
  CommitmentCandidate,
  CommitmentCandidateSource,
  CommitmentExtractionState,
  UpsertCandidateInput,
  UpsertEmailCandidateInput,
  EmailThreadJudgementOutcomeKind,
  AddEvidenceInput
} from "./types.js";
