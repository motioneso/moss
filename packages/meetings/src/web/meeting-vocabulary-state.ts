import { useEffect } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { randomUuid } from "@moss/module-web-sdk";
import {
  meetingTranscriptionOptions,
  normalizeMeetingVocabulary,
  type MeetingCapturePreferences
} from "@moss/shared";
import { meetingKeys, putMeetingPreferences } from "./client.js";
import { useSessionDraft } from "./session-draft.js";

export const vocabularyDraftKey = ["meetings", "vocabulary-draft"] as const;
interface VocabularyDraft {
  text: string;
  dirty: boolean;
  requestKey: string | null;
  error: string | null;
  acknowledgement: string | null;
}
const empty = (): VocabularyDraft => ({
  text: "",
  dirty: false,
  requestKey: null,
  error: null,
  acknowledgement: null
});
export function useMeetingVocabulary(
  preferences: MeetingCapturePreferences | undefined,
  blocked: boolean,
  settingsDraftKey: QueryKey
) {
  const client = useQueryClient();
  const draft = useSessionDraft(vocabularyDraftKey, empty);
  useEffect(() => {
    if (preferences)
      draft.update((current) =>
        current.dirty || current.requestKey
          ? current
          : {
              ...current,
              text: preferences.transcriptVocabulary.join("\n")
            }
      );
  }, [preferences, draft.update]);
  let validation: string | null = null;
  try {
    meetingTranscriptionOptions(
      preferences?.transcriptLanguage ?? null,
      normalizeMeetingVocabulary(draft.data.text.split("\n"))
    );
  } catch (error) {
    validation = error instanceof Error ? error.message : "Check your vocabulary.";
  }
  async function save(clear = false) {
    const current = client.getQueryData<VocabularyDraft>(vocabularyDraftKey);
    if (
      !current ||
      current.requestKey ||
      blocked ||
      client.getQueryData<{ requestKey: string | null }>(settingsDraftKey)?.requestKey ||
      !draft.currentSession() ||
      client.getQueryState(meetingKeys.preferences)?.status !== "success"
    )
      return;
    const savedPreferences = client.getQueryData<MeetingCapturePreferences>(
      meetingKeys.preferences
    );
    let terms: string[];
    try {
      terms = normalizeMeetingVocabulary(clear ? [] : current.text.split("\n"));
      meetingTranscriptionOptions(savedPreferences?.transcriptLanguage ?? null, terms);
    } catch (error) {
      draft.update((value) => ({
        ...value,
        error: error instanceof Error ? error.message : "Check your vocabulary."
      }));
      return;
    }
    const requestKey = randomUuid();
    draft.update((value) => ({
      ...value,
      dirty: true,
      requestKey,
      error: null,
      acknowledgement: null
    }));
    const owns = () =>
      draft.currentSession() &&
      client.getQueryData<VocabularyDraft>(vocabularyDraftKey)?.requestKey === requestKey;
    try {
      const saved = await putMeetingPreferences({ transcriptVocabulary: terms });
      if (!owns()) return;
      await client.cancelQueries({ queryKey: meetingKeys.preferences, exact: true });
      if (!owns()) return;
      client.setQueryData(meetingKeys.preferences, saved);
      draft.update(() => ({
        ...empty(),
        text: saved.transcriptVocabulary.join("\n"),
        acknowledgement: saved.transcriptVocabulary.length
          ? `Saved vocabulary: ${saved.transcriptVocabulary.join(", ")}. Applies to upcoming transcription.`
          : "Vocabulary cleared. Upcoming transcription sends no vocabulary hint."
      }));
    } catch {
      if (owns())
        draft.update((value) => ({
          ...value,
          requestKey: null,
          error:
            "Couldn’t save vocabulary. Your draft is kept here; the saved vocabulary still applies. Try Save vocabulary again."
        }));
    }
  }
  return {
    ...draft.data,
    validation,
    pending: !!draft.data.requestKey,
    edit: (text: string) =>
      draft.update((value) => ({
        ...value,
        text,
        dirty: true,
        error: null,
        acknowledgement: null
      })),
    save: () => save(),
    clear: () => save(true)
  };
}
