use proc_macro2::{TokenStream, TokenTree};
use std::{fs, path::Path};
fn literals(tokens: TokenStream, values: &mut Vec<String>) {
    for token in tokens {
        match token {
            TokenTree::Group(group) => literals(group.stream(), values),
            TokenTree::Literal(lit) => match syn::parse_str::<syn::Lit>(&lit.to_string()) {
                Ok(syn::Lit::Str(s)) => values.push(s.value()),
                Ok(syn::Lit::ByteStr(s)) => {
                    values.push(String::from_utf8_lossy(&s.value()).into_owned())
                }
                _ => {}
            },
            _ => {}
        }
    }
}
fn walk(path: &Path, errors: &mut Vec<String>) {
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name == "target" || name == ".git" {
            continue;
        }
        if path.is_dir() {
            walk(&path, errors);
            continue;
        }
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let relative = path.to_string_lossy();
        // The harness is an executable test/proof owner, never linked into the app.
        if relative.contains("/harness/") || relative.contains("/adapters/") {
            continue;
        }
        let source = fs::read_to_string(&path).unwrap();
        let syntax = syn::parse_file(&source).expect("valid Rust source");
        for item in syntax.items {
            if let syn::Item::Enum(item) = &item {
                if item.ident == "ParamSchema" {
                    let allowed = [
                        "Uuid", "Boolean", "Null", "Enum", "Integer", "Number", "Array", "Object",
                    ];
                    if item
                        .variants
                        .iter()
                        .any(|v| !allowed.contains(&v.ident.to_string().as_str()))
                    {
                        errors.push(format!(
                            "{}: free-text or undeclared payload kind",
                            path.display()
                        ));
                    }
                }
            }
            if let syn::Item::Struct(item) = &item {
                if item.ident == "Metadata" {
                    let allowed = [
                        "actor_user_id",
                        "module_id",
                        "job_kind",
                        "manifest_hash",
                        "params",
                    ];
                    if item.fields.iter().any(|f| {
                        f.ident
                            .as_ref()
                            .is_none_or(|id| !allowed.contains(&id.to_string().as_str()))
                            || !matches!(f.vis, syn::Visibility::Inherited)
                    }) {
                        errors.push(format!(
                            "{}: undeclared or public payload field",
                            path.display()
                        ));
                    }
                }
            }
        }
        let tokens = source.parse().expect("Rust source must tokenize");
        let mut values = vec![];
        literals(tokens, &mut values);
        for value in values {
            let lower = value.to_lowercase();
            if [
                "openai",
                "anthropic",
                "claude",
                "gemini",
                "gpt-",
                "gpt4",
                "gpt5",
                "ollama",
                "deepseek",
                "mistral",
                "llama",
                "qwen",
                "kimi",
                "system-one",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
            {
                errors.push(format!(
                    "{}: provider/model literal outside adapters",
                    path.display()
                ));
            }
        }
        let compact = source.replace(' ', "");
        if (compact.contains("std::fs")
            || compact.contains("tokio::fs")
            || compact.contains("std::net")
            || compact.contains("tokio::net"))
            && !relative.contains("/vault/")
        {
            errors.push(format!("{}: raw I/O outside owner", path.display()));
        }
    }
}
fn main() {
    let root = std::env::args().nth(1).expect("workspace root");
    let mut errors = vec![];
    walk(Path::new(&root), &mut errors);
    for error in &errors {
        eprintln!("BOUNDARY FAIL: {error}");
    }
    if !errors.is_empty() {
        std::process::exit(1);
    }
}
