pub use moss_module_host::registry_review::ReviewRequest;
pub fn approval_bytes(request: &ReviewRequest) -> anyhow::Result<Vec<u8>> {
    let mut bytes = b"moss-publish-review-v1\n".to_vec();
    bytes.extend(serde_json::to_vec(request)?);
    Ok(bytes)
}
