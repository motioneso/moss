//! Client commands use the existing signed-in session. No actor field or private key input.
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::archive::MAX_PACKAGE;
use serde_json::{json, Value};
use std::{io::Read, path::Path, time::Duration};

pub fn command(args: &[String]) -> Result<Value> {
    ensure!(matches!(args.len(), 4 | 5), "Usage: moss local sign ORIGIN PACKAGE OUTPUT | verify ORIGIN PACKAGE SIGNATURE OUTPUT; MOSS_LOCAL_SESSION supplies the session cookie");
    let signing = args[0] == "sign";
    ensure!(
        signing && args.len() == 4 || args[0] == "verify" && args.len() == 5,
        "Invalid local command"
    );
    let mut origin = reqwest::Url::parse(&args[1]).context("Invalid Moss origin")?;
    ensure!(
        origin.scheme() == "https"
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none(),
        "Use a plain HTTPS Moss origin"
    );
    origin.set_path(if signing {
        "/api/modules/local/sign"
    } else {
        "/api/modules/local/verify"
    });
    let cookie = std::env::var("MOSS_LOCAL_SESSION")
        .map_err(|_| anyhow::anyhow!("Set MOSS_LOCAL_SESSION to the signed-in session cookie"))?;
    let bytes = crate::read_bounded(Path::new(&args[2]), MAX_PACKAGE)?;
    let signature: Option<moss_module_host::local_packages::Signature> = if signing {
        None
    } else {
        Some(serde_json::from_slice(&crate::read_bounded(
            Path::new(&args[3]),
            1024 * 1024,
        )?)?)
    };
    let mut builder = reqwest::blocking::Client::builder();
    if let Some(path) = std::env::var_os("MOSS_LOCAL_CA") {
        builder = builder.add_root_certificate(reqwest::Certificate::from_pem(
            &crate::read_bounded(Path::new(&path), 1024 * 1024)?,
        )?);
    }
    let client = builder
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(120))
        .build()?;
    let response = client
        .post(origin.clone())
        .header(
            reqwest::header::ORIGIN,
            origin.origin().ascii_serialization(),
        )
        .header(reqwest::header::COOKIE, cookie)
        .json(&json!({"package":STANDARD.encode(bytes),"signature":signature}))
        .send()
        .map_err(|_| anyhow::anyhow!("Could not reach Moss for local package validation"))?;
    ensure!(
        response.status() != reqwest::StatusCode::NOT_IMPLEMENTED,
        "Local signing is unavailable on this host platform"
    );
    ensure!(response.status().is_success(), "Moss refused the local package; check the session, account prefix, install key and validation");
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Could not read Moss validation result"))?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "Moss validation result is too large"
    );
    let reply: Value = serde_json::from_slice(&bytes)?;
    let signature = reply.get("signature").context("Missing local signature")?;
    crate::artifacts::write_new(
        Path::new(args.last().unwrap()),
        &serde_json::to_vec(signature)?,
    )?;
    Ok(reply)
}
