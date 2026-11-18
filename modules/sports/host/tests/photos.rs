//! Photo port proofs that need no database. Run through modules/sports/tools/check.sh.
use access_context::AccessContext;
use base64::{engine::general_purpose::STANDARD, Engine};
use moss_module_host::runtime::{CallScope, Ports, Request};
use moss_sports_host::SportsPorts;
use serde_json::{json, Value};
use std::sync::Arc;

struct Nothing;
impl Ports for Nothing {
    fn invoke(&self, _: &CallScope, _: &str, _: &Request) -> anyhow::Result<Value> {
        anyhow::bail!("not used")
    }
    fn finish_call(&self, _: &CallScope, _: bool) -> anyhow::Result<()> {
        Ok(())
    }
}

const MARK: &str = "PLANTED-GPS-MARKER-77c1";

fn person(n: u8) -> AccessContext {
    AccessContext::new(format!("10000000-0000-4000-8000-00000000000{n}").parse().unwrap(), "t")
}
fn ports(dir: &std::path::Path) -> SportsPorts {
    SportsPorts::new(Arc::new(Nothing)).with_files(dir).unwrap()
}
fn picture(w: u32, h: u32, kind: image::ImageFormat) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([(x % 251) as u8, (y % 241) as u8, 90, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    let dynamic = image::DynamicImage::ImageRgba8(img);
    match kind {
        image::ImageFormat::Jpeg => dynamic.to_rgb8().write_to(&mut out, kind).unwrap(),
        _ => dynamic.write_to(&mut out, kind).unwrap(),
    }
    out.into_inner()
}
/// Puts a marker inside an EXIF-style APP1 segment right after the JPEG start marker.
fn with_metadata(jpeg: &[u8]) -> Vec<u8> {
    let payload = format!("Exif\0\0{MARK}");
    let len = (payload.len() + 2) as u16;
    let mut out = jpeg[..2].to_vec();
    out.extend([0xFF, 0xE1]);
    out.extend(len.to_be_bytes());
    out.extend(payload.as_bytes());
    out.extend(&jpeg[2..]);
    out
}
fn reencode(p: &SportsPorts, bytes: &[u8]) -> Value {
    p.run(&person(1), "reencode", &json!({"bodyBase64": STANDARD.encode(bytes)})).unwrap()
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn reencode_strips_metadata_and_fits_the_box() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    let input = with_metadata(&picture(2000, 1500, image::ImageFormat::Jpeg));
    assert!(contains(&input, MARK));
    let out = reencode(&p, &input);
    assert_eq!(out["ok"], true);
    let bytes = STANDARD.decode(out["bodyBase64"].as_str().unwrap()).unwrap();
    assert!(!contains(&bytes, MARK), "metadata survived the re-encode");
    assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    assert!(out["width"].as_u64().unwrap() <= 1280 && out["height"].as_u64().unwrap() <= 720);
    assert_eq!((out["originalWidth"].as_u64(), out["originalHeight"].as_u64()), (Some(2000), Some(1500)));
}

#[test]
fn reencode_never_enlarges_and_reads_every_format() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    for kind in [image::ImageFormat::Png, image::ImageFormat::Gif, image::ImageFormat::WebP, image::ImageFormat::Jpeg] {
        let out = reencode(&p, &picture(300, 200, kind));
        assert_eq!(out["ok"], true, "{kind:?}");
        assert_eq!((out["width"].as_u64(), out["height"].as_u64()), (Some(300), Some(200)));
    }
}

#[test]
fn reencode_refuses_tiny_and_unreadable_pictures() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    assert_eq!(reencode(&p, &picture(40, 400, image::ImageFormat::Png))["reason"], "too-small");
    assert_eq!(reencode(&p, b"not a picture at all")["reason"], "undecodable");
}

#[test]
fn files_round_trip_list_and_delete() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    let a = person(1);
    let body = STANDARD.encode(b"jpeg-bytes");
    p.run(&a, "put", &json!({"name": "k1.jpg", "bodyBase64": body})).unwrap();
    assert_eq!(p.run(&a, "get", &json!({"name": "k1.jpg"})).unwrap()["bodyBase64"], body);
    assert_eq!(p.run(&a, "list", &json!({})).unwrap()["names"], json!(["k1.jpg"]));
    p.run(&a, "delete", &json!({"name": "k1.jpg"})).unwrap();
    assert_eq!(p.run(&a, "get", &json!({"name": "k1.jpg"})).unwrap()["found"], false);
    assert_eq!(p.run(&a, "list", &json!({})).unwrap()["names"], json!([]));
    // A repeat delete is not an error.
    p.run(&a, "delete", &json!({"name": "k1.jpg"})).unwrap();
}

#[test]
fn another_person_cannot_see_or_delete_a_photo() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    let body = STANDARD.encode(b"private");
    p.run(&person(1), "put", &json!({"name": "k.jpg", "bodyBase64": body})).unwrap();
    assert_eq!(p.run(&person(2), "get", &json!({"name": "k.jpg"})).unwrap()["found"], false);
    assert_eq!(p.run(&person(2), "list", &json!({})).unwrap()["names"], json!([]));
    p.run(&person(2), "delete", &json!({"name": "k.jpg"})).unwrap();
    assert_eq!(p.run(&person(1), "get", &json!({"name": "k.jpg"})).unwrap()["found"], true);
}

#[test]
fn unsafe_names_and_oversize_bodies_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let p = ports(tmp.path());
    let a = person(1);
    let body = STANDARD.encode(b"x");
    for name in ["../x", "a/b", ".hidden", "UP.jpg", "", &"a".repeat(81)] {
        assert!(p.run(&a, "put", &json!({"name": name, "bodyBase64": body})).is_err(), "{name}");
    }
    let big = STANDARD.encode(vec![0u8; 800_000]);
    assert!(p.run(&a, "put", &json!({"name": "big.jpg", "bodyBase64": big})).is_err());
    assert!(p.run(&a, "bogus", &json!({})).is_err());
}
