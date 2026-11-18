use crate::{
    model::{Candidate, Directory, Person, ReadState},
    transport,
};
use leptos::prelude::*;
use moss_module_ui::{Button, ButtonSize, ButtonVariant, EmptyState, Field, FormLabel, Masthead};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
struct State {
    people: RwSignal<ReadState<Vec<Person>>>,
    candidates: RwSignal<ReadState<Vec<Candidate>>>,
    folder: RwSignal<ReadState<Option<String>>>,
    suggestions: RwSignal<ReadState<bool>>,
    directories: RwSignal<ReadState<Vec<Directory>>>,
    choosing: RwSignal<bool>,
    browse_path: RwSignal<String>,
    busy: RwSignal<bool>,
    notice: RwSignal<String>,
    failed: RwSignal<bool>,
}
impl State {
    fn new() -> Self {
        Self {
            people: RwSignal::new(ReadState::loading()),
            candidates: RwSignal::new(ReadState::loading()),
            folder: RwSignal::new(ReadState::loading()),
            suggestions: RwSignal::new(ReadState::loading()),
            directories: RwSignal::new(ReadState::loading()),
            choosing: RwSignal::new(false),
            browse_path: RwSignal::new(String::new()),
            busy: RwSignal::new(false),
            notice: RwSignal::new(String::new()),
            failed: RwSignal::new(false),
        }
    }
    fn load(self, section: &'static str) {
        leptos::task::spawn_local(async move {
            let path = match section {
                "people" => "/people?limit=50",
                "candidates" => "/people/match-candidates",
                "folder" => "/people/notes-settings",
                _ => "/people/note-suggestions",
            };
            let reply = transport::get::<Value>(path).await;
            match section {
                "people" => {
                    self.people.set(ReadState::result(reply.and_then(|v| {
                        serde_json::from_value(v["people"].clone()).map_err(|_| ())
                    })))
                }
                "candidates" => self.candidates.set(ReadState::result(reply.and_then(|v| {
                    serde_json::from_value(v["candidates"].clone()).map_err(|_| ())
                }))),
                "folder" => {
                    self.folder.set(ReadState::result(reply.and_then(|v| {
                        serde_json::from_value(v["folder"].clone()).map_err(|_| ())
                    })))
                }
                _ => self.suggestions.set(ReadState::result(
                    reply.and_then(|v| v["enabled"].as_bool().ok_or(())),
                )),
            }
        });
    }
    fn reload(self) {
        for section in ["people", "candidates", "folder", "suggestions"] {
            self.load(section);
        }
    }
    fn has_folder(self) -> bool {
        self.folder.get().value.flatten().is_some()
    }
    fn browse(self, path: String) {
        self.browse_path.set(path.clone());
        self.choosing.set(true);
        self.directories.set(ReadState::loading());
        leptos::task::spawn_local(async move {
            let result = transport::get::<Value>(&format!(
                "/people/note-folders?path={}",
                transport::segment(&path)
            ))
            .await;
            self.directories.set(ReadState::result(result.and_then(|v| {
                serde_json::from_value(v["directories"].clone()).map_err(|_| ())
            })));
        });
    }
    fn mutate(
        self,
        method: &'static str,
        path: String,
        body: Value,
        success: &'static str,
        done: Option<Callback<()>>,
    ) {
        if self.busy.get_untracked() {
            return;
        }
        self.busy.set(true);
        self.notice.set(String::new());
        self.failed.set(false);
        leptos::task::spawn_local(async move {
            match transport::request::<Value>(method, &path, body).await {
                Ok(value) => {
                    let text = if path == "/people/notes/refresh" {
                        let mut text = format!("Files found: {}; people synced: {}; files ignored: {}; items needing review: {}.", value["discovered"], value["projected"], value["ignored"], value["candidates"]);
                        if value["discovered"] == 0 {
                            text.push_str(" Choose another folder or add a person manually.");
                        }
                        if value["ignored"].as_u64().unwrap_or(0) > 0 {
                            text.push_str(" Ignored files need valid People-note frontmatter.");
                        }
                        text
                    } else {
                        success.into()
                    };
                    self.notice.set(text);
                    if let Some(done) = done {
                        done.run(());
                    }
                    self.reload();
                }
                Err(()) => {
                    self.failed.set(true);
                    self.notice.set("Could not finish this change. Try again. If your People folder is unavailable, choose another folder or clear it.".into());
                    if path == "/people/note-suggestions" {
                        self.load("suggestions");
                    }
                }
            }
            self.busy.set(false);
        });
    }
}

#[component]
pub fn PeopleSettings() -> impl IntoView {
    let state = State::new();
    Effect::new(move |_| state.reload());
    view! {
        <main class="people-settings">
            <Masthead title="People" eyebrow="Settings · Memory & context" lede="Keep your People notes and review suggested matches." compact=true/>
            <Show when=move || !state.notice.get().is_empty()>
                <p role=move || if state.failed.get() {"alert"} else {"status"}>{move || state.notice.get()}</p>
            </Show>
            <Show when=move || state.choosing.get() fallback=move || view!{
                <Folder state/>
                <Matches state/>
                <People state/>
                <Create state/>
            }><FolderPicker state/></Show>
        </main>
    }
}

#[component]
fn Retry(error: Signal<bool>, label: &'static str, retry: Callback<()>) -> impl IntoView {
    view! {<Show when=move || error.get()><div class="people-row" role="status"><p>{label}</p><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| retry.run(()))>"Try again"</Button></div></Show>}
}

#[component]
fn Folder(state: State) -> impl IntoView {
    view! {<section class="people-section" aria-labelledby="people-notes-title">
        <h2 id="people-notes-title">"People notes"</h2>
        <Retry error=Signal::derive(move || state.folder.get().error) label="Could not load the People folder." retry=Callback::new(move |_| state.load("folder"))/>
        <div class="people-row"><div class="people-copy"><h3>"Folder"</h3><p>{move || {
            let folder = state.folder.get();
            if folder.loading {"Loading your People folder…".into()} else if folder.error {"People folder unavailable.".into()} else {folder.value.flatten().unwrap_or("No People folder configured.".into())}
        }}</p></div><div class="people-actions">
            <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get()) on_click=Callback::new(move |_| state.browse(String::new()))>"Choose folder"</Button>
            <Show when=move || state.has_folder()><Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get()) on_click=Callback::new(move |_| state.mutate("PUT", "/people/notes-settings".into(), json!({"folder":null}), "People folder cleared.", None))>"Clear folder"</Button></Show>
        </div></div>
        <div class="people-row"><div class="people-copy"><h3>"Refresh from notes"</h3><p>"Read this folder and sync your People list."</p></div>
            <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get() || !state.has_folder()) on_click=Callback::new(move |_| state.mutate("POST", "/people/notes/refresh".into(), json!(null), "People refreshed.", None))>"Refresh from notes"</Button>
        </div>
        <Retry error=Signal::derive(move || state.suggestions.get().error) label="Could not load note suggestions." retry=Callback::new(move |_| state.load("suggestions"))/>
        <div class="people-row"><div class="people-copy"><h3>"Suggest note updates"</h3><p>"Let Moss suggest updates to your People notes."</p></div>
            <label class="people-actions"><input type="checkbox" role="switch" aria-label="Suggest note updates"
                prop:checked=move || state.suggestions.get().value.unwrap_or(true)
                disabled=move || state.busy.get() || state.suggestions.get().value.is_none()
                on:change=move |event| state.mutate("PUT", "/people/note-suggestions".into(), json!({"enabled":event_target_checked(&event)}), "Note suggestions updated.", None)/>"Suggest note updates"</label>
        </div>
    </section>}
}

#[component]
fn FolderPicker(state: State) -> impl IntoView {
    view! {<section class="people-section" aria-labelledby="people-folder-title"><h2 id="people-folder-title">"Choose a People folder"</h2>
        <div class="people-actions"><Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| state.choosing.set(false))>"Back to People"</Button>
            <Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| state.browse(String::new()))>"Allowed folders"</Button></div>
        <p>{move || state.browse_path.get()}</p>
        <Show when=move || !state.browse_path.get().is_empty()><Button disabled=Signal::derive(move || state.busy.get()) on_click=Callback::new(move |_| state.mutate("PUT", "/people/notes-settings".into(), json!({"folder":state.browse_path.get_untracked()}), "People folder saved.", Some(Callback::new(move |_| state.choosing.set(false)))))>"Use this folder"</Button></Show>
        <Retry error=Signal::derive(move || state.directories.get().error) label="Could not open this folder. Choose an allowed folder or try again." retry=Callback::new(move |_| state.browse(state.browse_path.get_untracked()))/>
        <Show when=move || state.directories.get().loading><p role="status">"Loading folders…"</p></Show>
        <div class="people-directory">{move || state.directories.get().value.unwrap_or_default().into_iter().map(|directory| view!{
            <Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| state.browse(directory.path.clone()))>{directory.name}</Button>
        }).collect_view()}</div>
    </section>}
}

#[component]
fn Matches(state: State) -> impl IntoView {
    view! {<section class="people-section" aria-labelledby="people-review-title"><h2 id="people-review-title">"Review matches"</h2>
        <Retry error=Signal::derive(move || state.candidates.get().error) label="Could not load match candidates." retry=Callback::new(move |_| state.load("candidates"))/>
        {move || { let data = state.candidates.get();
            if data.loading { return view!{<p role="status">"Loading match candidates…"</p>}.into_any(); }
            let pending: Vec<_> = data.value.unwrap_or_default().into_iter().filter(|c| c.status == "pending").collect();
            if pending.is_empty() && !data.error { return view!{<EmptyState title="Nothing to review" description="All match candidates are up to date."/>}.into_any(); }
            pending.into_iter().map(|candidate| {
                let destructive = candidate.destructive(); let label = candidate.label();
                let description = format!("{} — {} · {:.0}%", label, candidate.reason_summary.unwrap_or_default(), candidate.confidence * 100.0);
                let accept = format!("/people/match-candidates/{}/accept", transport::segment(&candidate.id));
                let reject = format!("/people/match-candidates/{}/reject", transport::segment(&candidate.id));
                view!{<div class="people-row"><div class="people-copy"><h3>{candidate.suggested_display_name.unwrap_or("Unnamed".into())}</h3><p>{description}</p>
                    {destructive.then(||view!{<p>"This action is irreversible — confirm in chat before accepting."</p>})}</div><div class="people-actions">
                    {if destructive {view!{<Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| transport::chat())>"Review in chat"</Button>}.into_any()} else {view!{<Button variant=ButtonVariant::AccentSoft disabled=Signal::derive(move || state.busy.get()) on_click=Callback::new(move |_| state.mutate("POST", accept.clone(), json!(null), "Match accepted.", None))>"Accept"</Button>}.into_any()}}
                    <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get()) on_click=Callback::new(move |_| state.mutate("POST", reject.clone(), json!(null), "Match rejected.", None))>"Reject"</Button>
                </div></div>}
            }).collect_view().into_any()
        }}
    </section>}
}

#[component]
fn People(state: State) -> impl IntoView {
    view! {<section class="people-section" aria-labelledby="people-list-title"><h2 id="people-list-title">"People"</h2>
        <Retry error=Signal::derive(move || state.people.get().error) label="Could not load people." retry=Callback::new(move |_| state.load("people"))/>
        {move || { let data=state.people.get();
            if data.loading { return view!{<p role="status">"Loading people…"</p>}.into_any(); }
            let people = data.value.unwrap_or_default();
            if people.is_empty() && !data.error { return view!{<EmptyState title="No people yet" description="Moss builds this list from your connected data sources."/>}.into_any(); }
            people.into_iter().map(|person| view!{<PersonRow state person/>}).collect_view().into_any()
        }}
    </section>}
}
#[component]
fn PersonRow(state: State, person: Person) -> impl IntoView {
    let editing = RwSignal::new(false);
    let name = RwSignal::new(person.display_name.clone());
    let path = format!("/people/{}", transport::segment(&person.id));
    let archive = format!("{path}/archive");
    let path = StoredValue::new(path);
    let control_id = StoredValue::new(format!("name-{}", person.id));
    view! {<div class="people-row"><div class="people-copy">
        <Show when=move || editing.get() fallback=move || view!{<h3>{person.display_name.clone()}</h3>}>
            <Field><FormLabel control_id=control_id.get_value()>"Display name"</FormLabel><input id=control_id.get_value() class="jds-input" prop:value=move || name.get() on:input=move |event| name.set(event_target_value(&event))/></Field>
        </Show>
        <p>{person.relationship_summary.or(person.context_summary).unwrap_or_default()}</p><p>{person.status}</p>
    </div><div class="people-actions">
        <Show when=move || editing.get() fallback=move || view!{<Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get() || !state.has_folder()) on_click=Callback::new(move |_| editing.set(true))>"Edit"</Button>}>
            <Button variant=ButtonVariant::AccentSoft disabled=Signal::derive(move || state.busy.get() || name.get().trim().is_empty()) on_click=Callback::new(move |_| state.mutate("PATCH", path.get_value(), json!({"displayName":name.get_untracked().trim()}), "Name saved.", Some(Callback::new(move |_| editing.set(false)))))>"Save name"</Button>
            <Button variant=ButtonVariant::Quiet on_click=Callback::new(move |_| editing.set(false))>"Cancel"</Button>
        </Show>
        <Button variant=ButtonVariant::Quiet disabled=Signal::derive(move || state.busy.get() || !state.has_folder()) on_click=Callback::new(move |_| state.mutate("POST", archive.clone(), json!(null), "Person archived.", None))>"Archive"</Button>
    </div></div>}
}
#[component]
fn Create(state: State) -> impl IntoView {
    let name = RwSignal::new(String::new());
    let email = RwSignal::new(String::new());
    view! {<section class="people-section" aria-labelledby="people-create-title"><h2 id="people-create-title">"Add a person manually"</h2>
        <p>"Creates a canonical Markdown People note in the selected Moss folder."</p>
        <form class="people-form" on:submit=move |event| {event.prevent_default(); if !state.has_folder() || name.get_untracked().trim().is_empty() {return;}
            let mut body=json!({"displayName":name.get_untracked().trim()}); let address=email.get_untracked();
            if !address.trim().is_empty() {body["emails"]=json!([address.trim()]);}
            state.mutate("POST", "/people".into(), body, "Person created.", Some(Callback::new(move |_| {name.set(String::new());email.set(String::new());})));
        }>
            <Field><FormLabel control_id="create-name">"Person name"</FormLabel><input id="create-name" class="jds-input" disabled=move || !state.has_folder() prop:value=move || name.get() on:input=move |event| name.set(event_target_value(&event))/></Field>
            <Field><FormLabel control_id="create-email">"Person email"</FormLabel><input id="create-email" class="jds-input" disabled=move || !state.has_folder() prop:value=move || email.get() on:input=move |event| email.set(event_target_value(&event))/></Field>
            <Button kind=moss_module_ui::ButtonType::Submit size=ButtonSize::Small variant=ButtonVariant::AccentSoft disabled=Signal::derive(move || state.busy.get() || !state.has_folder() || name.get().trim().is_empty())>"Create person"</Button>
        </form>
    </section>}
}
