import { esc, exportStatus, resolveSummary, transcriptTime } from "./format.mjs";
import { btn, field, hint, input, note, sectionHead, textarea } from "./kit.mjs";

const PACK = { calendar: "your calendar", people: "your people notes", memory: "your memory" };

export function evidenceHtml(evidence, artifact) {
  return `<div class="meetings-section">${evidence
    .map((ref) => {
      if (ref.kind === "personal-note")
        return `<details><summary>My notes · View source</summary><p class="meetings-transcript-text">${esc(artifact.inputs.personalNotes.slice(ref.startCharacter, ref.endCharacter))}</p></details>`;
      const seg = artifact.inputs.transcript?.segments.find(
        (s) => s.segmentId === ref.segmentId && s.revision === ref.segmentRevision
      );
      const label = `Transcript${seg ? ` · ${transcriptTime(seg.startMs)}–${transcriptTime(seg.endMs)}` : ""}`;
      return `<div class="meetings-transcript-turn"><button type="button" class="jds-btn jds-btn--link" data-act="evidence" data-seg="${esc(ref.segmentId)}" data-rev="${ref.segmentRevision}" data-start="${ref.startCharacter}" data-end="${ref.endCharacter}">${label}</button>${
        seg ? `<p class="meetings-transcript-text">${esc(seg.text.slice(ref.startCharacter, ref.endCharacter))}</p>` : ""
      }</div>`;
    })
    .join("")}</div>`;
}

export function artifactContent(artifact, typeId) {
  const content = resolveSummary(artifact.content);
  const type = typeId ?? artifact.content.recording?.typeId;
  const groupHeading = type === "brain-dump" || type === "idea" ? "Ideas" : "Topics";
  const flag = artifact.instructionFlag;
  return `<div class="meetings-section">${
    flag?.lines.length
      ? `<p role="status" class="jds-hint">This recording contained lines that looked like orders to the AI. The AI has no way to act on them. Quoted below so you can check the summary.</p><ul class="jds-hint">${flag.lines.map((l) => `<li>“${esc(l)}”</li>`).join("")}${flag.more > 0 ? `<li>and ${flag.more} more</li>` : ""}</ul>`
      : ""
  }${(flag?.packHits ?? [])
    .map(
      (h) =>
        `<p role="status" class="jds-hint">${h.count} ${h.count === 1 ? "line" : "lines"} in ${PACK[h.source]} looked like ${h.count === 1 ? "an order" : "orders"} to the AI. The AI has no way to act on ${h.count === 1 ? "it" : "them"}, so check the summary.</p>`
    )
    .join("")}<p class="meetings-transcript-text">${esc(content.overview)}</p>${
    artifact.content.recording?.ideaGroups.length ? `<h3 class="jds-eyebrow jds-eyebrow--strong">${groupHeading}</h3>` : ""
  }${(artifact.content.recording?.ideaGroups ?? [])
    .map(
      (g) =>
        `<section class="meetings-section"><p class="jds-label">${esc(g.title)}</p><ul>${g.ideas.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`
    )
    .join("")}${artifact.content.decisions.length ? '<h3 class="jds-eyebrow jds-eyebrow--strong">Decisions</h3>' : ""}${content.decisions
    .map(
      (c) =>
        `<article class="meetings-section"><hr class="jds-divider" /><p class="meetings-transcript-text">${esc(c.text)}</p>${evidenceHtml(c.evidence, artifact)}</article>`
    )
    .join("")}${
    artifact.content.openQuestions.length
      ? `<div><h3 class="jds-eyebrow jds-eyebrow--strong">Open questions</h3><ul>${content.openQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>`
      : ""
  }${content.warnings.map((w) => note(esc(w))).join("")}</div>`;
}

/** Edit form fields. Values come from the kept edit state, never from the saved version. */
export function editorHtml(artifact, headVersion, ed) {
  const busy = ed.op?.status === "running";
  const locked = busy || ed.op?.status === "retry";
  const c = ed.content;
  const stale = artifact.version !== headVersion;
  const listFields = (kind, prefix, label) =>
    c[kind]
      .map((item, i) =>
        field(`output-${prefix}-${i}`, `${label} ${i + 1}`, textarea(`output-${prefix}-${i}`, item.text ?? item, { max: 2000, disabled: locked, model: `${prefix}:${i}` }))
      )
      .join("");
  return `<div class="meetings-section">
${hint("Manual edits create a new version. Evidence references stay attached; review them when changing a claim. Edits are kept during this signed-in session.")}
${field("output-overview", "Overview", textarea("output-overview", c.overview, { rows: 5, max: 4000, disabled: locked, model: "ov" }))}
${listFields("decisions", "decisions", "Decision")}${listFields("actions", "actions", "Suggested action")}${listFields("openQuestions", "question", "Open question")}
<div class="meetings-actions">${btn(ed.op?.status === "retry" ? "Retry edit save" : "Save edits as new version", "edit-save", { disabled: busy || !ed.dirty || stale })}${btn("Close editor", "edit-close", { variant: "quiet" })}${btn("Discard edits", "edit-discard", { variant: "quiet", disabled: busy })}</div>
${stale ? `<p role="status" class="jds-hint">A newer version exists. Your edits are kept. Compare the latest version before editing it.</p><details><summary>Copy kept edits</summary>${field("kept-summary-edits", "Kept summary edits", textarea("kept-summary-edits", [c.overview, ...c.decisions.map((d) => d.text), ...c.openQuestions, ...c.actions.map((a) => a.text)].join("\n\n"), { rows: 8, readonly: true, model: "kept" }))}<p class="jds-hint">Copy this text, then choose the latest version to make a new edit. Reopening this version restores your kept edits.</p></details>` : ""}
${ed.op ? `<p role="status" class="jds-hint">${esc(ed.op.message)}</p>` : ""}
</div>`;
}

export function candidateHtml(candidate, artifact, rv) {
  const result = rv.result ?? candidate;
  const busy = rv.op?.status === "running";
  const uncertain = candidate.possibleMatchIds.length > 0;
  const p = candidate.proposal;
  if (!artifact) {
    return `<article class="meetings-section"><p>${esc(candidate.reviewState === "accepted" ? `Original suggestion: ${p.text}` : p.text)} · ${candidate.reviewState === "pending" ? "Pending review" : candidate.reviewState === "accepted" ? "Accepted" : "Dismissed"}</p><p role="status" class="jds-hint">${rv.sourceFailed ? "Couldn’t load this suggestion’s source. Retry before reviewing it." : "Loading this suggestion’s source…"}</p>${rv.sourceFailed ? btn("Retry loading action evidence", "cand-source", { variant: "secondary", data: `data-cand="${esc(candidate.id)}" data-version="${candidate.artifactVersion}"` }) : ""}</article>`;
  }
  const id = esc(candidate.id);
  const done = rv.op?.status === "done";
  return `<article class="meetings-section"><hr class="jds-divider" />${
    result.reviewState === "pending"
      ? field(`action-${id}`, "Suggested task", input(`action-${id}`, rv.title, { max: 500, model: `cand:${candidate.id}`, disabled: busy || rv.op?.status === "retry" }))
      : `<p>${esc(result.reviewState === "accepted" ? (done && rv.op.input.decision === "accept" ? `Created as: ${rv.op.input.title} · Accepted` : `Original suggestion: ${p.text} · Accepted`) : `${p.text} · Dismissed`)}</p>`
  }<p class="jds-hint">${p.ownerPhrase ? `Owner mentioned: ${esc(p.ownerPhrase)}` : "Unassigned"} · ${p.duePhrase ? `Date mentioned: ${esc(p.duePhrase)}` : "No due date"}. Choose a due date in Tasks.</p>${evidenceHtml(p.evidence, artifact)}${
    result.reviewState === "pending"
      ? `${uncertain ? `<p class="jds-hint">Possible duplicate of ${candidate.possibleMatchIds.length} earlier suggestion(s). Add to Tasks creates a separate task.</p>` : ""}<div class="meetings-actions">${
          rv.op?.status === "retry"
            ? btn("Retry review", "review", { data: `data-cand="${id}" data-decision="${rv.op.input.decision}"` })
            : `${btn("Add to Tasks", "review", { disabled: busy || !rv.title.trim() || rv.title.includes("\0"), data: `data-cand="${id}" data-decision="accept"` })}${btn("Dismiss", "review", { variant: "quiet", disabled: busy, data: `data-cand="${id}" data-decision="dismiss"` })}`
        }</div>`
      : result.acceptedTaskId
        ? `<p class="jds-hint">Current Task details and edits are in ${btn("Tasks", "go-tasks", { variant: "link" })}.</p>`
        : ""
  }${rv.op ? `<p role="status" class="jds-hint">${esc(rv.op.message)}</p>` : ""}</article>`;
}

export function vaultHtml(version, vault) {
  const receipt = vault.receipt ?? vault.receipts.list.find((r) => r.artifactVersion === version);
  const busy = vault.op?.status === "running";
  const conflict = receipt?.writeStatus === "conflict" || receipt?.errorCode === "meeting_vault_conflict";
  return `<section class="meetings-section" aria-label="Save to vault">${sectionHead("Save to vault", { number: "03" })}
${note(`Save version ${version} as a new private note in Moss private vault. Later summary versions create separate notes.`)}
${btn(vault.op?.status === "retry" ? "Retry save" : receipt ? "Retry private save" : "Save new private version", "vault-save", { disabled: busy || conflict })}
${vault.op ? `<p role="status" class="jds-hint">${esc(vault.op.message)}</p>` : receipt ? `<p role="status" class="jds-hint">${exportStatus(receipt)}</p>` : ""}
${vault.receipts.state === "failed" ? `<p role="status" class="jds-hint">Couldn’t check earlier vault saves. Retry the private save to reconcile this version.</p>` : ""}
${receipt?.noteReference ? `<details><summary>Saved file details</summary><p class="jds-hint">${esc(receipt.noteReference)}</p></details>` : ""}
</section>`;
}

export function copyHtml(body, omitted, statusText) {
  return `<div class="meetings-section">${field("meeting-markdown", "Meeting Markdown", textarea("meeting-markdown", body, { rows: 8, readonly: true, model: "markdown" }))}${omitted ? hint("This copy includes only the displayed transcript; some lines are outside its size limit.") : ""}${btn("Copy Markdown", "copy-md")}${statusText ? `<p role="status" class="jds-hint">${esc(statusText)}</p>` : ""}</div>`;
}

