//! Deliberately small, closed JSON Schema dialect for chat arguments.
use anyhow::{ensure, Context, Result};
use serde_json::Value;

pub(crate) fn check(schema: &Value) -> Result<()> {
    ensure!(
        schema.to_string().len() <= 64 * 1024,
        "Tool schema too large"
    );
    check_node(schema, 0)?;
    ensure!(
        schema["type"] == "object",
        "Tool arguments must be an object"
    );
    Ok(())
}
fn check_node(s: &Value, depth: usize) -> Result<()> {
    ensure!(depth <= 16, "Tool schema too deep");
    let object = s.as_object().context("Schema must be an object")?;
    let kind = s["type"].as_str().context("Schema type required")?;
    ensure!(
        matches!(
            kind,
            "object" | "string" | "number" | "integer" | "boolean" | "array"
        ),
        "Unsupported schema type"
    );
    for (key, value) in object {
        let valid = match key.as_str() {
            "type" => true,
            "description" => value
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.len() <= 4096),
            "examples" => value
                .as_array()
                .is_some_and(|v| !v.is_empty() && v.len() <= 16),
            "enum" => value
                .as_array()
                .is_some_and(|v| !v.is_empty() && v.len() <= 256),
            "properties" => kind == "object" && value.is_object(),
            "required" => kind == "object" && value.is_array(),
            "items" => kind == "array" && value.is_object(),
            "maxLength" => kind == "string" && value.as_u64().is_some(),
            "maxItems" => kind == "array" && value.as_u64().is_some(),
            "minimum" | "maximum" => matches!(kind, "number" | "integer") && value.is_number(),
            _ => false,
        };
        ensure!(valid, "Unsupported schema keyword or value");
    }
    if kind == "object" {
        let properties = s["properties"]
            .as_object()
            .context("Object properties required")?;
        ensure!(properties.len() <= 128, "Too many schema properties");
        for (name, child) in properties {
            ensure!(
                !name.is_empty()
                    && name.len() <= 128
                    && child["description"].as_str().is_some_and(|v| !v.is_empty()),
                "Property description required"
            );
            check_node(child, depth + 1)?;
        }
        if let Some(required) = object.get("required") {
            let mut seen = std::collections::BTreeSet::new();
            for key in required.as_array().context("Required must be an array")? {
                let key = key.as_str().context("Required name must be a string")?;
                ensure!(
                    properties.contains_key(key) && seen.insert(key),
                    "Unknown or repeated required property"
                );
            }
        }
    }
    if kind == "array" {
        check_node(&s["items"], depth + 1)?;
    }
    if s.get("minimum").is_some() && s.get("maximum").is_some() {
        ensure!(
            number_cmp(&s["minimum"], &s["maximum"]) != std::cmp::Ordering::Greater,
            "Inverted schema bounds"
        );
    }
    if let Some(values) = s["enum"].as_array() {
        let mut bare = s.clone();
        bare.as_object_mut().unwrap().remove("enum");
        bare.as_object_mut().unwrap().remove("examples");
        for v in values {
            validate(&bare, v)?;
        }
    }
    if let Some(examples) = s["examples"].as_array() {
        for example in examples {
            validate(s, example)?;
        }
    }
    Ok(())
}

pub(crate) fn validate(schema: &Value, value: &Value) -> Result<()> {
    let valid = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("integer") => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value.as_f64().is_some_and(|n| n.fract() == 0.0)
        }
        Some("boolean") => value.is_boolean(),
        Some("array") => value.is_array(),
        _ => false,
    };
    ensure!(valid, "Tool argument type mismatch");
    if let Some(values) = schema["enum"].as_array() {
        ensure!(values.contains(value), "Tool argument outside enum");
    }
    if let Some(object) = value.as_object() {
        let properties = schema["properties"]
            .as_object()
            .context("Object properties required")?;
        // Closed objects keep unvalidated model fields out of guest code.
        for (key, child) in object {
            validate(properties.get(key).context("Unknown tool argument")?, child)?;
        }
        if let Some(required) = schema["required"].as_array() {
            ensure!(
                required
                    .iter()
                    .all(|k| k.as_str().is_some_and(|k| object.contains_key(k))),
                "Required tool argument missing"
            );
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(max) = schema["maxLength"].as_u64() {
            ensure!(text.chars().count() as u64 <= max, "Tool argument too long");
        }
    }
    if let Some(items) = value.as_array() {
        if let Some(max) = schema["maxItems"].as_u64() {
            ensure!(items.len() as u64 <= max, "Too many tool items");
        }
        for item in items {
            validate(&schema["items"], item)?;
        }
    }
    if value.is_number() {
        ensure!(
            schema
                .get("minimum")
                .is_none_or(|min| number_cmp(value, min) != std::cmp::Ordering::Less)
                && schema
                    .get("maximum")
                    .is_none_or(|max| number_cmp(value, max) != std::cmp::Ordering::Greater),
            "Tool argument outside bounds"
        );
    }
    Ok(())
}
fn number_cmp(a: &Value, b: &Value) -> std::cmp::Ordering {
    fn integral(v: &Value) -> Option<i128> {
        v.as_i64()
            .map(i128::from)
            .or_else(|| v.as_u64().map(i128::from))
            .or_else(|| {
                let n = v.as_f64()?;
                (n.fract() == 0.0 && n >= i128::MIN as f64 && n < i128::MAX as f64)
                    .then_some(n as i128)
            })
    }
    match (integral(a), integral(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => a
            .as_f64()
            .unwrap()
            .partial_cmp(&b.as_f64().unwrap())
            .unwrap(),
    }
}
