# Transcription vocabulary: provider contracts

Research date: 2026-10-24. Supports feasibility/design for #3584; this is not an
approved product spec or evidence of a configured endpoint accepting vocabulary.
Only public documentation/source was read. No provider requests, audio uploads,
configuration changes or device operations were performed.

## Finding

Vocabulary hints are feasible for particular ASR implementations, but an
OpenAI-compatible transcription URL does not establish that capability. The
portable product concept is a spelling/context hint, with support determined by
the actual endpoint and model. It is not a guaranteed dictionary, correction
rule, or instruction to insert words absent from the audio.

| Implementation                                     | Established contract                                                                                                                                                                                                                    | Important boundary                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Groq `whisper-large-v3` / `whisper-large-v3-turbo` | The speech-to-text guide lists both models and an optional `prompt` for context/style and unfamiliar spellings, limited to 224 tokens. `language` accepts an input ISO 639-1 language code; `verbose_json` supports segment timestamps. | Prompt guidance should use the audio's language. Documentation establishes an available API feature, not accuracy for a particular recording or acceptance by an arbitrary compatible endpoint. |
| OpenAI `whisper-1`                                 | Official documentation supports a transcription `prompt` for names, acronyms, vocabulary and previous-chunk context; its documented limit is 224 tokens.                                                                                | Prompting has less control than newer transcription models. Do not treat token limits as character limits.                                                                                      |
| Other OpenAI transcription models                  | The official guide says `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` support prompting; `gpt-4o-transcribe-diarize` does not.                                                                                                       | Response formats differ: the reference permits only `json` for the two named non-diarizing GPT-4o models. A consumer requiring `verbose_json` needs separate compatibility work.                |
| faster-whisper library                             | `WhisperModel.transcribe` accepts `initial_prompt` and `hotwords`. The non-batched initial prompt supplies first-window context; `hotwords` are hints and have no effect when `prefix` is present.                                      | This is a Python API, not an HTTP contract. Batched inference documents an initial prompt for each window, so window semantics depend on the serving path.                                      |
| Speaches using faster-whisper                      | The inspected HTTP route accepts `prompt` and nonstandard `hotwords`; its Whisper executor maps them to faster-whisper's `initial_prompt` and `hotwords`.                                                                               | This proves that particular pinned implementation's wiring, not every server marketed as OpenAI compatible, nor any deployed Moss endpoint/version.                                             |

## Primary evidence

1. [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text),
   sections Supported Models, request parameters and Prompting. The parameter is
   described as “Prompt to guide the model's style or specify how to spell
   unfamiliar words. (limited to 224 tokens)”. The prompting guidance says to use
   the same language as the audio and distinguishes these hints from chat
   instructions. The guide lists the transcription endpoint separately from
   English translation; turbo supports transcription, not translation.
2. [Official OpenAI documentation: Prompting](https://developers.openai.com/api/docs/guides/speech-to-text#prompting)
   explicitly covers names/acronyms/vocabulary, the 224-token `whisper-1` limit,
   GPT-4o prompting and the diarization exception.
3. [Official OpenAI transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
   describes `prompt` as optional style/previous-segment text that should match
   the audio language, and gives the model-specific response-format constraints.
4. [Official OpenAI documentation: Add transcription context](https://developers.openai.com/api/docs/guides/speech-to-text#add-transcription-context)
   describes `gpt-transcribe`'s distinct `keywords` and `languages` fields.
   Keywords are hints, not required output; the guide calls for evaluation of
   unspoken-term insertion. For this model `languages` replaces singular
   `language`; it must not be blindly combined with a legacy request contract.
   This model-specific extension is not evidence of Groq or custom-endpoint
   support and is not a proposal to migrate Moss's selected model.
5. [faster-whisper source, pinned revision](https://github.com/SYSTRAN/faster-whisper/blob/9e472ae9de8bb374552f531f752654554b76b2d6/faster_whisper/transcribe.py):
   batched initial-prompt handling at lines 178–190 and documentation at 318;
   non-batched contract at 858–860; hotwords documentation at 892–893;
   `get_prompt` at 1570–1602. That function tokenizes hints and trims hotwords
   from the end, retaining the beginning, while previous tokens retain the
   suffix. With `max_length = 448` at line 726, each of those source slices has a
   223-token bound. These are implementation details, not Groq's public limit
   or a universal endpoint budget.
6. [Speaches HTTP route, pinned revision](https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/routers/stt.py#L120)
   accepts multipart `language`, `prompt` and `hotwords`, builds its request at
   lines 157–171, then invokes the selected executor.
   [Its Whisper executor](https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/executors/whisper.py#L155)
   forwards `prompt` to batched `initial_prompt` and passes `hotwords` separately
   at lines 161–171. The faster-whisper
   [README](https://github.com/SYSTRAN/faster-whisper#community-integrations)
   identifies Speaches as one community HTTP integration, reinforcing the
   distinction between library and serving contract.

## Consequences for a Moss design

- Prefer a provider-neutral vocabulary concept in the Meeting contract, with
  explicit endpoint/model capability handling at the ASR boundary. `prompt` is
  one adapter representation; `hotwords` and `keywords` are not universal fields.
- Validate the complete serialized hint against the selected implementation's
  actual budget. Neither a word count nor a Unicode character count proves a
  224-token limit. Include separators and any added context in that budget; do
  not silently discard terms or assume every provider truncates the same way.
  The inspected Groq guide states the limit without specifying rejection versus
  truncation for overflow. OpenAI's newer `gpt-transcribe` context guide says an
  oversized prompt is rejected, but that does not establish `whisper-1` or
  compatible-server overflow behavior.
- A concise list of relevant spellings is consistent with the documented
  spelling/context purpose, but no inspected contract makes comma-separated
  glossary syntax a guaranteed dictionary format. Its serialization, language,
  budget and relevance still need a defined product policy and real evaluation.
- Treat automatic language detection and multilingual vocabulary as a design
  decision. Primary guides recommend a matching prompt language, but they do
  not establish how Moss should associate a shared list with multiple languages.
- A successful HTTP response does not attest that hints affected recognition.
  The inspected contracts do not provide a standard “vocabulary applied” receipt.
  Verify Moss's serialized request independently; use real representative audio
  and negative controls to evaluate recognition and accidental word insertion.
  Neither a term appearing in output nor a successful unknown-field request
  establishes general semantic support.
- Vocabulary sent in a transcription request reaches the selected endpoint as
  request content. Saving a reusable personal list can expose terms unrelated
  to the particular clip; decide and explain its scope before sending it. This
  research did not inspect provider retention policies, runtime logging,
  transport libraries, deployed-server logging or tenant isolation, and makes
  no claims about those properties.

## Still unproved

The actual configured endpoint/model's vocabulary behavior; deployed local
wrapper support; exact tokenization and overflow behavior for each supported
adapter; per-window context policy; accuracy, omissions or hallucinations on
real Meeting audio; UI scope and behavior after a provider change. No setting
should be represented as working from this document alone.
