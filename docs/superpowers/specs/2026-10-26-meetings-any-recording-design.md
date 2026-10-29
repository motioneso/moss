# Meetings for any recording

Status: design and all six mockups approved by Ben on 2026-10-26.
See the [mockup index](mockups/meetings-any-recording/index.html).
This change records the approved design only; no build plan or product
implementation has started in this change.

## Intent

Meetings was built for work meetings and virtual appointments. Ben now records brain dumps, conversations and ideas too, including ring recordings that arrive with no name. Moss should read each recording, work out what kind it is, name it, decide whether it is personal or work, and file what it learned in the right place. Moss should also learn from the recording, so a walk spent on game ideas tells Moss what Ben is working on.

The module keeps the name Meetings. Ben expects meetings to stay about 90% of the content.

## Goals

- Moss picks a recording type and writes a real title from what was said.
- Moss decides personal or work for each recording.
- Moss adds useful content to the user's notes and updates memory when something is worth remembering.
- Moss finds the user's own filing method and uses it. Nothing about PARA or any other method is built in.
- The user can change the type list through chat. A settings screen for it is optional.
- One Meetings screen serves every type. Sections under the title change with the type.
- The user can add a recording by hand, either by pasting or typing a transcript or by uploading an audio file for Moss to transcribe. Both go through the same type, title, label and filing steps as any other recording.
- The Meetings list can be filtered by recording type.
- A recorded or uploaded meeting links to its matching Calendar event. The event details offer a way to open that meeting.

## Non-goals

- No rename of the module.
- No separate lighter screen for non-meetings (option B in the design discussion was rejected).
- No new live capture paths. Mac capture, import and ring delivery stay as they are. Manual entry is the only new way in.
- No hardcoded folder names, areas or methodologies.

## Anti-goals

- A work recording must never write into personal memory or notes, and the reverse.
- Moss must not rewrite or reorganize the user's folders. It reads the structure and files into it.
- A wrong guess must never be silent. Low confidence on personal versus work, or on the filing destination, produces a message in the main chat.

## Today (verified 2026-10-26)

- A background job runs when a recording stops and calls the summary generator (`packages/meetings/src/stop-summary-jobs.ts`, `output-service.ts`).
- The model receives the transcript and the user's typed notes. It returns an overview, decisions, open questions, suggested actions and warnings (`packages/shared/src/meeting-output-api.ts`). The meeting title is not an input.
- Nothing picks a type, a title or a personal or work label. The only choice is a summary style (general, one-to-one, project review, interview) taken from a saved preference.
- A new recording is titled "Untitled meeting". When its summary is current, the first sentence of the overview becomes the title (`output-service.ts`).
- Meetings writes summaries to Notes through a port it declares (`export-port.ts`), and the host supplies the adapter. The host then queues a Memory index update.
- Meetings never writes to Memory directly. No declared event for Memory or Notes writes exists.
- No personal or work concept exists in Memory, Notes, Meetings or the shared contracts.

## Behavior

### Manual entry

- A pasted transcript already has an ingest route today (`transcript-routes.ts`). The screen needs a clear way to reach it.
- Uploading an audio file for transcription is new unless the builder finds an existing path. It uses the user's configured speech-to-text provider.
- Manual entries start with no title and no type, and Moss fills both in like any other recording. The user may supply a title and a type up front, and Moss keeps what they gave.

### Classification

- After transcription, Moss assigns a type, a title and a personal or work label in the same step that produces the summary.
- Default types are work meeting, appointment, brain dump, conversation, idea and other.
- The user edits the type list by asking in chat. Each type carries a name and a short description Moss uses to decide.
- The summary style follows the type. Types the user adds fall back to the general style until the user picks another. Changing a type's style is chat-only for now. (Builder-check call.)
- The type list and its chat tool belong to Meetings, declared in its manifest. (Builder-check call.)

### Personal or work

- Moss picks one label. If it is unsure, it keeps the label it picked, posts in the main chat saying which side it chose and why, and the user can reply to flip it.
- Flipping moves the filed note and relabels the memory changes with it. This needs a record of what Moss wrote and where, which also feeds the on-screen box and its undo. (Builder-check call.)
- The data model has two fixed sides, personal and work. The privacy rule needs a value it can enforce. Which folders each side maps to comes from the user's own structure (see Filing), so no folder name is built in. (Builder-check call.)
- The label is stored on the recording and on every memory fact and filed note Moss writes from it.

### Filing and structure discovery

- Moss reads the vault folder layout and looks for a methodology such as PARA, Zettelkasten or a plain folder tree.
- Moss stores what it found as a memory fact, so later recordings reuse it.
- Moss shows its finding to the user the first time, in the main chat, and asks for confirmation. Recordings that finish before confirmation go to a default folder, and Moss offers to move them once the user confirms. (Builder-check call.)
- Filing widens the existing summary-export port so it carries a destination and the label. Meetings does not call the vault directly. (Builder-check call.)
- For each recording, Moss prefers a matching project or topic note when one exists and falls back to the broader folder for the label. If the layout offers nothing, it uses a default folder.
- Vault access goes through `VaultContext`, never raw file access.

### Memory updates

- Moss proposes memory facts from a recording when they are new and durable, such as "Ben is prototyping wind and grass for Ranger".
- Every memory fact carries the personal or work label.
- Meetings gains a declared way to write memory facts. Moss routes through the owning module's public surface, never its internals.

### Filtering the Meetings list

- A type filter sits beside search on the Meetings list. It starts at All types.
- The options come from the user's current type list, including types added through chat.
- Type and text search work together. Returning to All types clears the type filter without clearing the search.
- A changed recording type is reflected in the filtered list.

### Calendar links

- After a meeting is recorded or uploaded, Moss looks for a matching event on the user's Calendar and links the recording when there is a clear match.
- Clicking that Calendar event opens its existing details panel. An Open meeting action opens the associated recording in Meetings, with its transcript, notes and summary.
- For uploads, use the original recording time when available, rather than treating the upload time as the meeting time. Missing or ambiguous evidence must not create an arbitrary link.
- A recurring meeting links to the matching occurrence, not the whole series. Events without an accessible linked recording have no Open meeting action.
- A Calendar link does not grant access to a private recording. Matching and navigation must respect the current user's access to both resources.
- Calendar and Meetings communicate through declared public surfaces or host adapters, preserving module isolation. The matching method and thresholds are left to the builder.

### Screen

- One layout. Under the title sits a type chip the user can change, then the type's sections.
- A box on the screen lists what Moss added to notes and memory, with undo and a way to review the changes.
- A work meeting still shows attendees, decisions and action items. A brain dump shows grouped ideas and open questions.

## Constraints

- Private by default. Recordings, labels and memory facts are owner-only.
- Provider-agnostic AI. The classification step asks for a capability and the router picks the model.
- Module isolation applies to the Memory write path and to Notes.
- Job payloads carry IDs only, never transcript content.
- A product change updates the app map in the same pull request.
- Front-end mockups of every changed screen must be agreed with Ben before the build starts. The discussion mockup covers only the main recording screen in the brain-dump state.

## Decisions by Ben

- Option A, one screen with sections that change by type.
- Module name stays Meetings.
- Moss picks personal or work, flags uncertainty in the main chat, and the user can change it.
- Nothing hardcoded. Moss discovers the filing method and stores it in memory.
- Types are user-configurable, at least through chat.
- The Meetings list can be filtered by type (2026-10-26).
- Recorded and uploaded meetings link to matching Calendar events, and event details offer Open meeting (2026-10-26).
- All six mockups are approved: recording type menu, What Moss took box, type configuration conversation, manual entry, Meetings type filter and Calendar event link (2026-10-26).

## Left to the builder

- The exact default type list and wording of each type description. Starting point above is a suggestion.
- The public surface that lets Meetings write memory facts.
- How confidence is measured and the threshold for a chat message.
- How the discovered methodology is stored as a memory fact, and how stale findings are refreshed.
- Retitling existing recordings. Default is to leave them alone.
- Whether ring and import recordings with a user-set title keep it. Default is yes.

## Open items

- Build planning and implementation are tracked in #3777.
- All changed screens have approved [mockups](mockups/meetings-any-recording/index.html). Build planning and product implementation remain separate work.
