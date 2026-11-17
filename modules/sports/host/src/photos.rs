//! Host side of source photos. The guest cannot spend the compute to decode and re-encode a
//! picture, and it has no binary file store, so both live here behind one declared resource.
use access_context::AccessContext;
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageReader, Limits};
use moss_module_host::runtime::{authorize, CallScope, Ports, Request};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Cursor, sync::Arc};
use vault::{EntryKind, Root, VaultContext};

/// The declared resource a guest names to reach photo files and the re-encoder.
pub const PHOTO_FILES: &str = "source-photo-files";
const FOLDER: &str = "photos";
const MAX_INPUT: usize = 2 * 1024 * 1024;
const MAX_STORED: usize = 786_432;
const MAX_TEXT: usize = 64 * 1024;
const MAX_NAME: usize = 80;
const MAX_SIDE: u32 = 8_000;
const JPEG_QUALITY: u8 = 80;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    name: Option<String>,
    text: Option<String>,
    body_base64: Option<String>,
    max_width: Option<u32>,
    max_height: Option<u32>,
    min_short_side: Option<u32>,
}

/// Answers the photo file and re-encode operations for the Sports module and passes every
/// other call on.
pub struct SportsPorts {
    next: Arc<dyn Ports>,
    root: Option<Root>,
}

impl SportsPorts {
    pub fn new(next: Arc<dyn Ports>) -> Self {
        Self { next, root: None }
    }

    /// `files` is the host's module files folder. Photos live under `sports/<person>/photos`.
    pub fn with_files(mut self, files: &std::path::Path) -> Result<Self> {
        self.root = Some(Root::create(files)?.create_subdir("sports")?);
        Ok(self)
    }

    fn folder(&self, access: &AccessContext) -> Result<VaultContext> {
        let root = self.root.as_ref().context("Photo storage is not set up")?;
        let account = VaultContext::for_module_files(root, access)?;
        account.create_dir(FOLDER)?;
        Ok(account)
    }
}

impl Ports for SportsPorts {
    fn invoke(&self, scope: &CallScope, port: &str, request: &Request) -> Result<Value> {
        if port != "kv" || request.resource != PHOTO_FILES || scope.module().id != "sports" {
            return self.next.invoke(scope, port, request);
        }
        authorize(scope.module(), port, request)?;
        self.run(scope.access(), &request.operation, &request.parameters)
    }
    fn finish_call(&self, scope: &CallScope, success: bool) -> Result<()> {
        self.next.finish_call(scope, success)
    }
}

impl SportsPorts {
    /// Runs one photo operation as `access`. Every file lives under that person's own folder.
    pub fn run(
        &self,
        access: &AccessContext,
        operation: &str,
        parameters: &Value,
    ) -> Result<Value> {
        let p: Params = serde_json::from_value(parameters.clone())?;
        match operation {
            "reencode" => reencode(&p),
            "put" => {
                let bytes = match &p.text {
                    Some(text) => {
                        ensure!(text.len() <= MAX_TEXT, "The record is too large");
                        text.clone().into_bytes()
                    }
                    None => decode(p.body_base64.as_deref(), MAX_STORED)?,
                };
                self.folder(access)?
                    .write(&path(p.name.as_deref())?, &bytes)?;
                Ok(json!({"stored": true}))
            }
            "get" => match self.folder(access)?.read(&path(p.name.as_deref())?) {
                Ok(bytes) => {
                    let text = std::str::from_utf8(&bytes).ok().filter(|_| bytes.len() <= MAX_TEXT);
                    Ok(json!({"found": true, "bodyBase64": STANDARD.encode(&bytes), "text": text}))
                }
                Err(vault::VaultError::NotFound(_)) => Ok(json!({"found": false})),
                Err(error) => Err(error.into()),
            },
            "list" => {
                let names: Vec<String> = self
                    .folder(access)?
                    .list(FOLDER)?
                    .into_iter()
                    .filter(|entry| entry.kind == EntryKind::File)
                    .map(|entry| entry.name)
                    .collect();
                Ok(json!({"names": names}))
            }
            "delete" => match self.folder(access)?.remove(&path(p.name.as_deref())?) {
                Ok(()) | Err(vault::VaultError::NotFound(_)) => Ok(json!({"deleted": true})),
                Err(error) => Err(error.into()),
            },
            _ => bail!("Unknown photo operation"),
        }
    }
}

fn path(name: Option<&str>) -> Result<String> {
    let name = name.context("A file name is required")?;
    ensure!(
        !name.is_empty()
            && name.len() <= MAX_NAME
            && !name.starts_with('.')
            && name.bytes().all(|b| b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || matches!(b, b'.' | b'-' | b'_')),
        "The photo file name is unsafe"
    );
    Ok(format!("{FOLDER}/{name}"))
}

fn decode(body: Option<&str>, limit: usize) -> Result<Vec<u8>> {
    let body = body.context("The picture bytes are required")?;
    ensure!(
        body.len() <= limit.div_ceil(3) * 4 + 4,
        "The picture is too large"
    );
    let bytes = STANDARD
        .decode(body)
        .context("The picture bytes are not valid")?;
    ensure!(bytes.len() <= limit, "The picture is too large");
    Ok(bytes)
}

/// Decodes a JPEG, PNG, GIF or WebP, fits it inside the box without enlarging it, flattens any
/// transparency onto white and writes a fresh JPEG. A fresh encode carries no metadata.
fn reencode(p: &Params) -> Result<Value> {
    let bytes = decode(p.body_base64.as_deref(), MAX_INPUT)?;
    let (max_w, max_h) = (p.max_width.unwrap_or(1280), p.max_height.unwrap_or(720));
    ensure!(
        (1..=4096).contains(&max_w) && (1..=4096).contains(&max_h),
        "The size box is out of range"
    );
    let mut reader = ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let Ok(source) = reader.decode() else {
        return Ok(json!({"ok": false, "reason": "undecodable"}));
    };
    let (ow, oh) = (source.width(), source.height());
    if ow.min(oh) < p.min_short_side.unwrap_or(64) {
        return Ok(json!({"ok": false, "reason": "too-small"}));
    }
    let fitted = if ow > max_w || oh > max_h {
        source.resize(max_w, max_h, FilterType::Triangle)
    } else {
        source
    };
    let rgb = flatten(&fitted);
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    ensure!(
        out.len() <= MAX_STORED,
        "The re-encoded picture is too large"
    );
    Ok(json!({
        "ok": true,
        "contentType": "image/jpeg",
        "bodyBase64": STANDARD.encode(&out),
        "width": rgb.width(),
        "height": rgb.height(),
        "originalWidth": ow,
        "originalHeight": oh,
        "bytes": out.len(),
    }))
}

fn flatten(image: &DynamicImage) -> image::RgbImage {
    let rgba = image.to_rgba8();
    let mut out = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let blend = |c: u8| ((u16::from(c) * alpha + 255 * (255 - alpha)) / 255) as u8;
        out.put_pixel(
            x,
            y,
            image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    out
}
