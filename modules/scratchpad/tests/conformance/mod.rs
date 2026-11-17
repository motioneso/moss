//! The same behavioral assertions execute native code and the shipped Wasm component.
use serde_json::{json, Value};

pub fn check(mut call: impl FnMut(&str, Value) -> Value) {
    let read = |parameters| json!({"tool":"scratchpad.read","parameters":parameters});
    let append = |parameters| json!({"tool":"scratchpad.append","parameters":parameters});
    let prepare = |parameters| json!({"name":"prepareScratchpadAction","parameters":parameters});
    assert_eq!(call("tool", read(json!({})))["data"]["characterCount"], 0);
    for input in [
        json!({}),
        json!({"text":null}),
        json!({"text":3}),
        json!({"text":" \n\t "}),
    ] {
        assert_eq!(
            call("tool", append(input))["data"]["error"],
            "Cannot append empty text to the scratchpad"
        );
    }
    assert_eq!(
        call("tool", append(json!({"text":"😀".repeat(1001)})))["data"]["error"],
        "Text is too long to append in one call (2000 character limit)"
    );
    assert_eq!(
        call("tool", append(json!({"text":"  first😀  "})))["data"]["appended"],
        "first😀"
    );
    let before = call("tool", read(json!({})));
    let card = call("api", prepare(json!({"text":"second"})));
    assert_eq!(
        card,
        json!({"content":"user_authored","target":"Your scratchpad",
        "fields":[{"label":"Text to append","value":"second"}],"revision":1,"characterCount":7})
    );
    assert_eq!(
        call("tool", read(json!({}))),
        before,
        "preparation cannot change the note"
    );
    for input in [
        json!({}),
        json!({"text":null}),
        json!({"text":"   "}),
        json!({"text":"ok","actor":"forged"}),
    ] {
        assert_eq!(call("api", prepare(input)), Value::Null);
    }
    assert_eq!(
        call("tool", append(json!({"text":"\u{feff}second\u{a0}"})))["data"]["appended"],
        "\nsecond"
    );
    let settings = call(
        "api",
        json!({"name":"prepareScratchpadSettings","parameters":{"syncToNotes":true}}),
    );
    assert_eq!(
        settings["fields"],
        json!([{"label":"Copy scratchpad to your connected notes folder","value":"Yes"}])
    );
    assert_eq!(settings["revision"], 2);
    assert_eq!(settings["notesFolderConfigured"], true);
    let after = call("tool", read(json!({})));
    assert_eq!(after["data"]["body"], "first😀\nsecond");
    assert_eq!(after["data"]["characterCount"], 14);
    assert_eq!(after["data"]["revision"], 2);
}
