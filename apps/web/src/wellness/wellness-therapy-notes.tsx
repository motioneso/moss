import { Button, SectionHead } from "@moss/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { LocaleSettingsDto, WellnessEmotionCore } from "@moss/shared";
import { queryKeys } from "../api/query-keys";
import { listTherapyNotes, createTherapyNote, deleteTherapyNote } from "../api/client";
import { formatDate, useUserLocale } from "../locale/locale-format";
import { emoColor, coreLabel, type Theme } from "./emotion-taxonomy";

function NotebookPenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <path d="m21.378 3.626-1.004-1.004a2.121 2.121 0 0 0-3 0l-5.37 5.374 2 2 5.37-5.374" />
    </svg>
  );
}
function Trash2Icon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}
function CheckSmallIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function MessageIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function formatNoteDate(iso: string | null, locale: LocaleSettingsDto): string {
  if (!iso) return "Today";
  return formatDate(iso, locale, { month: "short", day: "numeric" });
}

interface Props {
  theme?: Theme;
}

export function WellnessTherapyNotes({ theme = "light" }: Props) {
  const queryClient = useQueryClient();
  const locale = useUserLocale();
  const [draft, setDraft] = useState("");

  const notesQuery = useQuery({
    queryKey: queryKeys.wellness.therapyNotes,
    queryFn: listTherapyNotes
  });

  const addMutation = useMutation({
    mutationFn: (body: string) => createTherapyNote({ body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.therapyNotes });
    }
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteTherapyNote(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.wellness.therapyNotes });
    }
  });

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    // Mutate outside a setState updater — never inside one (StrictMode double-fire trap).
    // The draft clears only once the note is stored, so a failed save keeps the text.
    addMutation.mutate(t, { onSuccess: () => setDraft("") });
  };

  const notes = notesQuery.data?.notes ?? [];

  return (
    <section className="wl-sec">
      <SectionHead number="05" title="For your next session" />
      <div className="wl-therapy">
        <p className="wl-therapy__intro">
          Things you want to bring up in therapy — jot them when they&apos;re fresh, and
          they&apos;ll be waiting when you sit down.
        </p>
        <div className="wl-tadd">
          <span className="wl-tadd__ic">
            <NotebookPenIcon size={16} />
          </span>
          <textarea
            rows={1}
            aria-label="Note for your next session"
            placeholder="Something to talk through…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
            }}
          />
          <span className="wl-tadd__btn">
            <button
              type="button"
              className="primary-button wl-fs13"
              style={{ padding: "5px 12px", minHeight: "unset" }}
              onClick={add}
              disabled={!draft.trim() || addMutation.isPending}
            >
              Add
            </button>
          </span>
        </div>
        {addMutation.isError ? (
          <div className="wl-modal__note wl-modal__note--error" role="alert">
            Couldn&apos;t save that note. It&apos;s still in the box, so try again.
          </div>
        ) : null}
        <div className="wl-tnotes">
          {notesQuery.isPending ? (
            <p className="wl-subtle-text" role="status">
              Loading session notes…
            </p>
          ) : null}
          {notesQuery.isError ? (
            <div className="wl-tdone">
              <span className="wl-subtle-text" role="status">
                Couldn&apos;t load notes.{" "}
                <Button variant="link" onClick={() => void notesQuery.refetch()}>
                  Try again
                </Button>
              </span>
            </div>
          ) : notesQuery.data && notes.length === 0 ? (
            <div className="wl-tdone">
              <span className="ic">
                <CheckSmallIcon />
              </span>
              Nothing queued — add a note above.
            </div>
          ) : null}
          {notes.map((nt) => {
            const linkedEmotion = nt.linkedEmotion as WellnessEmotionCore | null;
            const c = linkedEmotion ? emoColor(linkedEmotion, theme) : null;
            return (
              <div key={nt.id} className="wl-tnote">
                <span className="wl-tnote__mark">
                  <MessageIcon />
                </span>
                <div className="wl-tnote__main">
                  <div className="wl-tnote__tx">{nt.body}</div>
                  <div className="wl-tnote__meta">
                    <span className="wl-tnote__date">
                      {formatNoteDate(nt.createdAt ?? null, locale)}
                    </span>
                    {linkedEmotion && c ? (
                      <span
                        className="wl-tnote__link"
                        style={{ "--em-tint": c.tint } as React.CSSProperties}
                      >
                        <span className="d" />
                        Linked to a {coreLabel(linkedEmotion)} check-in
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  className="wl-tnote__x"
                  aria-label="Remove"
                  onClick={() => removeMutation.mutate(nt.id)}
                >
                  <Trash2Icon />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
