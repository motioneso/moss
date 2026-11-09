# Remove individual private-object checks; the matching rejection test must turn red.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Source mutations are only allowed in disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$mutations = @(
    @{ before = '| FILE_LIST_DIRECTORY'; after = ''; test = 'private_directory_and_file_round_trip' },
    @{ before = 'control & SE_DACL_PROTECTED == 0'; after = 'false'; test = 'rejects_broader_missing_duplicate_and_inherited_acl_entries' },
    @{ before = 'compare_acl(dacl, expected_acl)'; after = 'Ok(())'; test = 'rejects_broader_missing_duplicate_and_inherited_acl_entries' },
    @{ before = '|| (!directory && info.links != 1)'; after = ''; test = 'rejects_hard_links_and_wrong_object_types' },
    @{ file = 'directory.rs'; before = '.share_mode(FILE_SHARE_READ)'; after = '.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)'; test = 'ancestor_with_existing_write_handle_is_refused' },
    @{ file = 'directory.rs'; before = 'info.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0'; after = 'false'; test = 'refuses_junction_at_each_depth_without_touching_target' },
    @{ file = 'directory.rs'; before = 'check_name(name)?;'; after = 'let _ = name;'; test = 'refuses_aliases_and_child_path_escapes' },
    @{ file = 'directory/state.rs'; before = 'Err(error) => return Err(error),'; after = 'Err(_) => (),'; test = 'state_replacement_preserves_old_state_on_failure_and_rejects_nonprivate_target' }
)
foreach ($mutation in $mutations) {
    $relative = if ($mutation.file) { 'windows_private/' + $mutation.file } else { 'windows_private.rs' }
    $source = Join-Path $root ('rust-spike/portability/src/' + $relative)
    $original = [IO.File]::ReadAllText($source)
    try {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p portability --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/private-negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        & "$PSScriptRoot/windows-child.ps1" -BuildReport '.rust-locks/private-negative-build.jsonl' -Filter $mutation.test -ExpectFailure
    } finally {
        [IO.File]::WriteAllText($source, $original)
    }
}
