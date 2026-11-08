//! Shared Leptos markup for Park Press. Load the host's park-press.css; module CSS owns
//! layout only. Options mirror packages/ui, and no private data or direct HTTP client lives here.
use leptos::prelude::*;
pub mod calendar;
#[derive(Clone, Copy, Default)]
pub enum ButtonVariant {
    #[default]
    Primary,
    Secondary,
    Quiet,
    AccentSoft,
    Danger,
    Field,
    Link,
    Chip,
}
impl ButtonVariant {
    fn class(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Secondary => "secondary",
            Self::Quiet => "quiet",
            Self::AccentSoft => "accentSoft",
            Self::Danger => "danger",
            Self::Field => "field",
            Self::Link => "link",
            Self::Chip => "chip",
        }
    }
}
#[derive(Clone, Copy, Default)]
pub enum ButtonSize {
    Small,
    #[default]
    Medium,
    Large,
}
#[derive(Clone, Copy, Default)]
pub enum ButtonType {
    #[default]
    Button,
    Submit,
}
#[component]
pub fn Button(
    #[prop(optional)] variant: ButtonVariant,
    #[prop(optional)] size: ButtonSize,
    #[prop(optional)] kind: ButtonType,
    #[prop(optional)] block: bool,
    #[prop(optional)] active: bool,
    #[prop(into,default=false.into())] disabled: Signal<bool>,
    #[prop(optional)] on_click: Option<Callback<leptos::ev::MouseEvent>>,
    children: Children,
) -> impl IntoView {
    let mut class = format!("jds-btn jds-btn--{}", variant.class());
    match size {
        ButtonSize::Small => class.push_str(" jds-btn--sm"),
        ButtonSize::Large => class.push_str(" jds-btn--lg"),
        _ => (),
    }
    if block {
        class.push_str(" jds-btn--block");
    }
    if active {
        class.push_str(" jds-btn--active");
    }
    view! {<button type=match kind {ButtonType::Button=>"button",ButtonType::Submit=>"submit"} class=class disabled=move||disabled.get() on:click=move|event|{if let Some(callback)=on_click {callback.run(event);}}>{children()}</button>}
}
#[component]
pub fn Field(children: Children) -> impl IntoView {
    view! {<div class="jds-field">{children()}</div>}
}
#[component]
pub fn FormLabel(#[prop(into)] control_id: String, children: Children) -> impl IntoView {
    view! {<label class="jds-label" for=control_id>{children()}</label>}
}
#[component]
pub fn EmptyState(
    #[prop(into)] title: String,
    #[prop(optional, into)] description: Option<String>,
    #[prop(optional)] children: Option<Children>,
) -> impl IntoView {
    view! {<div class="jds-empty"><div class="jds-empty__title">{title}</div>{description.map(|text|view!{<div class="jds-empty__sub">{text}</div>})}{children.map(|actions|view!{<div class="jds-empty__actions">{actions()}</div>})}</div>}
}
#[component]
pub fn Masthead(
    #[prop(into)] title: String,
    #[prop(optional)] field: bool,
    #[prop(optional)] compact: bool,
    #[prop(optional, into)] eyebrow: Option<String>,
    #[prop(optional, into)] lede: Option<String>,
    #[prop(optional)] children: Option<Children>,
) -> impl IntoView {
    let mut class = "jds-masthead".to_string();
    if field {
        class.push_str(" jds-masthead--field");
    }
    if compact {
        class.push_str(" jds-masthead--compact");
    }
    view! {<header class=class><div class="jds-masthead__row"><div class="jds-masthead__main">{eyebrow.map(|s|view!{<p class="jds-masthead__eyebrow">{s}</p>})}<h1 class="jds-masthead__title"><span>{title}</span></h1>{lede.map(|s|view!{<p class="jds-masthead__lede">{s}</p>})}</div>{children.map(|aside|view!{<div class="jds-masthead__aside">{aside()}</div>})}</div></header>}
}
