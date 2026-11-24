//! Signed records and real package screens; all media enters through the existing index signature.
use super::common;
use moss_module_host::{
    archive,
    registry::{Artifact, Index},
    trust::{self, RegistryIdentity},
};
use serde_json::json;
use std::{fs, path::Path};
pub fn publish(keys: &common::Keys, folder: &Path, first: bool, media: Option<&Path>) -> Artifact {
    let mut base = keys.write(folder, "1.0.0", 1, vec![]);
    let mut identity: RegistryIdentity =
        serde_json::from_slice(&fs::read(folder.join("registry.json")).unwrap()).unwrap();
    let (id, source, name, publisher, category) = if first {
        (
            "catalog-notes",
            "moss-fixture",
            "Notes",
            "Moss",
            "Productivity",
        )
    } else {
        (
            "community.garden",
            "community-fixture",
            "Garden planner",
            "Garden Collective",
            "Home",
        )
    };
    identity.id = source.into();
    identity.name = if first {
        "Moss registry"
    } else {
        "Community registry"
    }
    .into();
    identity.publishers.get_mut("sample").unwrap().prefix =
        if first { "" } else { "community" }.into();
    let bytes = serde_json::to_vec(&identity).unwrap();
    fs::write(folder.join("registry.json"), &bytes).unwrap();
    fs::write(
        folder.join("registry.json.sig"),
        common::Keys::sign(&keys.root, &bytes),
    )
    .unwrap();
    let mut screenshots = vec![];
    if let Some(media) = media {
        fs::create_dir_all(folder.join("media")).unwrap();
        for (file, caption) in [("overview.png", "Overview"), ("activity.png", "Activity")] {
            let bytes = fs::read(media.join(file)).unwrap();
            let file = format!("{}.png", trust::digest(&bytes));
            fs::write(folder.join("media").join(&file), bytes).unwrap();
            screenshots.push(json!({"file":file,"caption":caption}));
        }
    }
    let presentation: moss_module_host::catalog_presentation::Presentation=serde_json::from_value(json!({"name":name,"description":if first{"Your notes, close at hand."}else{"Plan your garden."},"publisher":publisher,"category":category,"screenshots":screenshots})).unwrap();
    let mut artifacts = vec![];
    for version in if media.is_some() {
        vec!["1.0.0", "1.1.0"]
    } else {
        vec!["1.0.0"]
    } {
        let mut manifest = common::manifest(version);
        manifest.id = id.into();
        manifest.name = name.into();
        manifest.publisher = publisher.into();
        manifest.settings = vec![
            json!({"id":format!("{id}.settings"),"label":format!("{name} settings"),"description":"Module preferences","path":format!("/{id}-settings"),"scope":"user"}),
        ];
        manifest
            .screens
            .insert(format!("/{id}-settings"), "ui/settings.html".into());
        manifest
            .screens
            .insert(format!("/{id}"), "ui/overview.html".into());
        let mut files = common::files(&manifest);
        files.insert("ui/settings.html".into(),format!("<!doctype html><html><link rel=stylesheet href=/module-shared/park-press.css><main><h1>{name} settings</h1><label>Notifications <input type=checkbox checked></label></main></html>").into_bytes());
        files.insert("ui/overview.html".into(),format!("<!doctype html><html><link rel=stylesheet href=/module-shared/park-press.css><main><h1>{name}</h1><p>{category}</p><section class=jds-brief><h2>Recently</h2><p>No recent activity.</p></section></main></html>").into_bytes());
        let bytes = archive::pack(&files).unwrap();
        base.id = id.into();
        base.version = version.parse().unwrap();
        base.digest = trust::digest(&bytes);
        base.size = bytes.len() as u64;
        base.signature = common::Keys::sign(&keys.publisher, base.digest.as_bytes());
        base.presentation = Some(presentation.clone());
        fs::write(
            folder.join(format!("packages/{}.mosspkg", base.digest)),
            bytes,
        )
        .unwrap();
        artifacts.push(base.clone());
    }
    let index = Index {
        publish_reviews: Default::default(),
        serial: if media.is_some() { 2 } else { 1 },
        expires: chrono::Utc::now() + chrono::Duration::days(1),
        signing_key: "online".into(),
        modules: artifacts.clone(),
        revoked: if media.is_some() {
            vec![moss_module_host::registry::Revocation {
                target: artifacts[0].digest.clone(),
                reason: "Publisher maintenance notice".into(),
                level: moss_module_host::registry::RevocationLevel::Warn,
            }]
        } else {
            vec![]
        },
    };
    let bytes = serde_json::to_vec(&index).unwrap();
    fs::write(folder.join("index.json"), &bytes).unwrap();
    fs::write(
        folder.join("index.json.sig"),
        common::Keys::sign(&keys.index, &bytes),
    )
    .unwrap();
    artifacts[0].clone()
}
