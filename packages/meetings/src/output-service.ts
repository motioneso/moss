import { projectMeetingOverview } from "./history-projection.js";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingStopSummaryRepository } from "./stop-summary-repository.js";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type {
  GenerateMeetingOutputInput,
  MeetingOutputInputs,
  MeetingOutputResult
} from "@moss/shared";
import { MeetingOutputError, MeetingOutputsRepository } from "./output-repository.js";
import { getMeetingOutputTemplate, validateMeetingOutput } from "./output-validation.js";

export type MeetingOutputGenerator = (
  actor: AccessContext,
  input: {
    inputs: MeetingOutputInputs;
    template: { id: string; version: number; name: string; guidance: string };
    signal: AbortSignal;
  }
) => Promise<{ content: unknown; modelRoute: string }>;

/** Provider work stays outside transactions; only a reserved request may dispatch once. */
export class MeetingOutputService {
  constructor(
    private readonly dataContext: Pick<DataContextRunner, "withDataContext">,
    private readonly generator: MeetingOutputGenerator,
    private readonly repository = new MeetingOutputsRepository(),
    private readonly stopSummaries = new MeetingStopSummaryRepository(undefined, repository)
  ) {}

  async generate(
    actor: AccessContext,
    meetingId: string,
    input: GenerateMeetingOutputInput
  ): Promise<MeetingOutputResult> {
    meetingId = meetingId.toLowerCase();
    const template = getMeetingOutputTemplate(input.templateId, input.templateVersion);
    if (
      !template ||
      [
        input.expectedOutputVersion,
        input.expectedTranscriptRevision,
        input.expectedNotesRevision
      ].some((value) => !Number.isSafeInteger(value) || value < 0)
    )
      throw new MeetingOutputError("meeting_output_invalid_input", 400);
    const reservation = await this.dataContext.withDataContext(actor, (db) =>
      this.reserve(db, meetingId, input)
    );
    return this.complete(actor, meetingId, input, reservation);
  }

  async generateOnStop(
    actor: AccessContext,
    meetingId: string,
    requestKey: string
  ): Promise<MeetingOutputResult | null> {
    const admitted = await this.dataContext.withDataContext(actor, async (db) => {
      try {
        await this.repository.lock(db, meetingId);
      } catch (error) {
        // Deletion cascades the intent, but its metadata-only job may still be queued.
        if (
          error instanceof MeetingOutputError &&
          error.code === "meeting_not_found" &&
          error.statusCode === 404
        )
          return null;
        throw error;
      }
      const input = await this.stopSummaries.admit(db, meetingId, requestKey);
      if (!input) return null;
      return { input, reservation: await this.reserve(db, meetingId, input) };
    });
    return admitted ? this.complete(actor, meetingId, admitted.input, admitted.reservation) : null;
  }

  private async reserve(db: DataContextDb, meetingId: string, input: GenerateMeetingOutputInput) {
    const encoded = JSON.stringify({ kind: "generate", ...input });
    await this.repository.lock(db, meetingId);
    const previous = await this.repository.request(db, meetingId, input.requestKey, encoded);
    if (previous)
      return {
        result: previous.result_json
          ? (JSON.parse(previous.result_json) as MeetingOutputResult)
          : { status: "pending" as const, requestKey: input.requestKey }
      };
    const pendingKey = await this.repository.pendingGeneration(db, meetingId);
    if (pendingKey) throw new MeetingOutputError("meeting_output_busy", 409);
    const head = await this.repository.head(db, meetingId);
    const inputs = await this.repository.inputs(db, meetingId);
    if (
      (head?.version ?? 0) !== input.expectedOutputVersion ||
      inputs.notesRevision !== input.expectedNotesRevision ||
      (inputs.transcript?.transcriptRevision ?? 0) !== input.expectedTranscriptRevision
    )
      throw new MeetingOutputError("meeting_output_version_conflict", 409, {
        outputVersion: head?.version ?? 0,
        notesRevision: inputs.notesRevision,
        transcriptRevision: inputs.transcript?.transcriptRevision ?? 0
      });
    if (!inputs.personalNotes.trim() && !inputs.transcript?.segments.length)
      throw new MeetingOutputError("meeting_output_evidence_unavailable", 400);
    await this.repository.reserve(db, meetingId, input.requestKey, encoded);
    return { inputs };
  }

  private async complete(
    actor: AccessContext,
    meetingId: string,
    input: GenerateMeetingOutputInput,
    reservation: Awaited<ReturnType<MeetingOutputService["reserve"]>>
  ): Promise<MeetingOutputResult> {
    const template = getMeetingOutputTemplate(input.templateId, input.templateVersion)!;
    const encoded = JSON.stringify({ kind: "generate", ...input });
    if (reservation.result)
      return reservation.result.status === "saved"
        ? { ...reservation.result, replayed: true }
        : reservation.result;
    const inputs = reservation.inputs;
    try {
      // Transport must honor this deadline. It must resolve live routing/credential state
      // itself and reject tool-capable transports; the service never retries or falls back.
      const signal = AbortSignal.timeout(110000);
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new MeetingOutputError("meeting_output_interrupted"));
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      let generated: Awaited<ReturnType<MeetingOutputGenerator>>;
      try {
        generated = await Promise.race([
          this.generator(actor, { inputs, template, signal }),
          aborted
        ]);
      } finally {
        if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
      }
      const validated = validateMeetingOutput(generated.content, inputs);
      if (!generated.modelRoute || generated.modelRoute.length > 1024)
        throw new Error("Invalid route receipt");
      const warnings = [...validated.warnings.slice(0, 47)];
      if (inputs.transcript?.omittedSegments)
        warnings.push("Some retained transcript segments were omitted from this bounded input.");
      if (inputs.transcript?.containsProvisional)
        warnings.push("This output includes provisional transcript evidence.");
      warnings.push(
        "Capture gaps and participant attribution have not been independently verified."
      );
      const result = await this.dataContext.withDataContext(actor, async (db) => {
        const currentMeeting = await this.repository.lock(db, meetingId);
        const current = await this.repository.inputs(db, meetingId);
        const receipt = await this.repository.request(db, meetingId, input.requestKey, encoded);
        if (!receipt) throw new MeetingOutputError("meeting_output_interrupted");
        if (receipt.result_json) return JSON.parse(receipt.result_json) as MeetingOutputResult;
        const head = await this.repository.head(db, meetingId);
        const stale =
          (head?.version ?? 0) !== input.expectedOutputVersion ||
          current.notesRevision !== inputs.notesRevision ||
          (current.transcript?.transcriptRevision ?? 0) !==
            (inputs.transcript?.transcriptRevision ?? 0);
        const artifact = await this.repository.save(db, {
          meetingId,
          inputs,
          templateId: template.id,
          templateVersion: template.version,
          modelRoute: generated.modelRoute,
          content: validateMeetingOutput({ ...validated, warnings }, inputs),
          origin: "generated",
          stale
        });
        if (!stale && currentMeeting.title === "Untitled meeting" && validated.overview.trim()) {
          let title = projectMeetingOverview(
            validated.overview.trim().split(/\n|(?<=[.!?])\s/u)[0]!
          );
          while (Buffer.byteLength(title) > 240) title = [...title].slice(0, -1).join("");
          if (title && Buffer.byteLength(title) <= 240)
            await new MeetingRecordsRepository().putTitle(db, {
              meetingId,
              expectedTitle: "Untitled meeting",
              title
            });
        }
        const outcome = { status: "saved" as const, artifact, replayed: false };
        await this.repository.finish(db, meetingId, input.requestKey, outcome);
        return outcome;
      });
      return result;
    } catch (error) {
      // No provider errors, prompts or credentials are persisted or returned to callers.
      const code =
        error instanceof MeetingOutputError ? error.code : "meeting_output_generation_failed";
      const result: MeetingOutputResult = { status: "failed", requestKey: input.requestKey, code };
      return await this.dataContext.withDataContext(actor, async (db) => {
        await this.repository.lock(db, meetingId);
        const receipt = await this.repository.request(db, meetingId, input.requestKey, encoded);
        if (receipt?.result_json) return JSON.parse(receipt.result_json) as MeetingOutputResult;
        await this.repository.finish(db, meetingId, input.requestKey, result);
        return result;
      });
    }
  }
}
