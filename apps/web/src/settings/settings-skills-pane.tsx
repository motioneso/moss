import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@moss/ui";
import {
  createChatSkill,
  deleteChatSkill,
  importChatSkill,
  listChatSkills,
  setChatSkillEnabled,
  updateChatSkill
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Badge, Field, Group, Note, PaneHead, Row, Switch } from "./settings-ui";
import { skillCommandName } from "../chat/skill-autocomplete";

/* Same compose form serves create and edit: clicking "Edit" loads a skill's
   name/description/body into the fields and the submit switches to an update.
   The update request never includes `frontmatter`, so the repository leaves a
   skill's existing frontmatter untouched (see packages/chat/src/skills/repository.ts). */
export function SettingsSkillsPane() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [flow, setFlow] = useState<"create" | "edit" | "upload" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const listActionRef = useRef<HTMLButtonElement | null>(null);

  const skillsQuery = useQuery({
    queryKey: queryKeys.chat.skills,
    queryFn: listChatSkills,
    retry: false
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.chat.skills });

  const resetForm = () => {
    setEditingId(null);
    setFlow(null);
    setName("");
    setDescription("");
    setBody("");
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), description: description.trim() || null, body };
      return editingId ? updateChatSkill(editingId, input) : createChatSkill(input);
    },
    onSuccess: () => {
      const wasEditing = editingId !== null;
      resetForm();
      void invalidate();
      listActionRef.current?.focus();
      toast(wasEditing ? "Skill updated" : "Skill created");
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) =>
      setChatSkillEnabled(input.id, { enabled: input.enabled }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChatSkill(id),
    onSuccess: () => {
      void invalidate();
      setFlow(null);
      toast("Skill deleted", { tone: "drift", icon: <Trash2 size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => importChatSkill(file),
    onSuccess: (data) => {
      void invalidate();
      setFlow(null);
      setUploadStatus(`Imported "${data.skill.name}".`);
      listActionRef.current?.focus();
    },
    onError: (error) => {
      setUploadStatus(null);
      toast(readError(error), { tone: "drift" });
    }
  });

  const skills = skillsQuery.data?.skills ?? [];
  const openCreate = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setBody("");
    setUploadStatus(null);
    setFlow("create");
  };
  const openUpload = () => {
    setUploadStatus(null);
    setFlow("upload");
  };
  const openEdit = (skill: (typeof skills)[number]) => {
    setEditingId(skill.id);
    setName(skill.name);
    setDescription(skill.description ?? "");
    setBody(skill.body);
    setFlow("edit");
  };

  return (
    <>
      <PaneHead
        title="Skills"
        desc="Reusable prompts you can invoke by name in chat, e.g. /daily-standup."
      />

      <Group
        title={`Skills${skills.length > 0 ? ` (${skills.length})` : ""}`}
        action={
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={openCreate}>
              <Plus size={15} aria-hidden="true" /> Create skill
            </Button>
            <Button ref={listActionRef} variant="secondary" size="sm" onClick={openUpload}>
              <Upload size={15} aria-hidden="true" /> Upload file
            </Button>
          </span>
        }
      >
        {skills.length === 0 ? (
          <Row name="No skills yet" desc="Create one above, or upload a skill file." />
        ) : (
          skills.map((skill) => (
            <Row
              key={skill.id}
              name={skill.name}
              desc={[`/${skillCommandName(skill.name)}`, skill.description]
                .filter(Boolean)
                .join(" · ")}
              control={
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge tone={skill.enabled ? "forest" : "neutral"}>
                    {skill.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Switch
                    ariaLabel={`Enable ${skill.name}`}
                    checked={skill.enabled}
                    disabled={toggleMutation.isPending}
                    onChange={(enabled) => toggleMutation.mutate({ id: skill.id, enabled })}
                  />
                  <Button variant="quiet" size="sm" onClick={() => openEdit(skill)}>
                    Edit
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() =>
                      confirm({
                        title: `Delete "${skill.name}"?`,
                        description: "This cannot be undone.",
                        confirmLabel: "Delete",
                        danger: true,
                        onConfirm: () => deleteMutation.mutate(skill.id)
                      })
                    }
                    title="Delete"
                    icon={<Trash2 size={15} aria-hidden="true" />}
                  />
                </span>
              }
            />
          ))
        )}
      </Group>
      {flow === null && uploadStatus ? <Note>{uploadStatus}</Note> : null}

      {flow === "create" || flow === "edit" ? (
        <Group title={flow === "edit" ? "Edit skill" : "Create skill"}>
          <Field label="Name *">
            <input
              className="jds-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Daily standup"
              aria-label="Skill name (required)"
              aria-required="true"
              required
            />
          </Field>
          <Field label="Description" hint="Shown in the skill list. Optional.">
            <input
              className="jds-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Summarize yesterday and today"
              aria-label="Skill description"
            />
          </Field>
          <Field
            label="Instructions"
            hint="Required. Applied only to this invoked turn; your typed request follows these instructions."
          >
            <textarea
              className="jds-textarea"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="Skill instructions (required)"
              aria-required="true"
              required
              placeholder="Ask for yesterday, today, and blockers."
            />
          </Field>
          <Note>Command: /{skillCommandName(name) || "…"}</Note>
          <Field label="Save" group>
            <span style={{ display: "flex", gap: 8 }}>
              <Button
                variant="accentSoft"
                size="sm"
                disabled={saveMutation.isPending || !name.trim() || !body.trim()}
                onClick={() => saveMutation.mutate()}
              >
                {flow === "edit" ? "Save changes" : "Create skill"}
              </Button>
              <Button variant="quiet" size="sm" onClick={resetForm}>
                Cancel
              </Button>
            </span>
          </Field>
        </Group>
      ) : null}

      {flow === "upload" ? (
        <Group title="Upload file">
          <Row
            name="Upload a skill file"
            desc="Markdown with frontmatter — name, description, and a body."
            control={
              <label>
                <input
                  type="file"
                  accept=".md,text/markdown"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) uploadMutation.mutate(file);
                  }}
                />
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}
                >
                  <Upload size={13} aria-hidden="true" />
                </span>
              </label>
            }
          />
          {uploadStatus ? <Note>{uploadStatus}</Note> : null}
          <Button variant="quiet" size="sm" onClick={resetForm}>
            Cancel
          </Button>
        </Group>
      ) : null}
    </>
  );
}
