use moss_scratchpad_module::shortcut::is_valid;

#[test]
fn accepts_a_real_modifier_plus_a_key() {
    for ok in ["mod+shift+s", "ctrl+s", "alt+x", "  Mod + Shift + S  ", "cmd+alt+j"] {
        assert!(is_valid(ok), "{ok}");
    }
}

#[test]
fn rejects_missing_unknown_or_shift_only_modifiers() {
    for bad in ["", "s", "mod", "shift+s", "shift+shift+s", "hyper+s", "mod++", "+s", "super+s"] {
        assert!(!is_valid(bad), "{bad}");
    }
}

#[test]
fn rejects_every_spelling_of_the_command_palette_shortcut() {
    for bad in ["mod+k", "ctrl+k", "cmd+k", "meta+k", "ctrl+ctrl+k", "ctrl+shift+k", "alt+cmd+K", "ctrl+cmd+k"] {
        assert!(!is_valid(bad), "{bad}");
    }
    assert!(is_valid("alt+k"));
}
