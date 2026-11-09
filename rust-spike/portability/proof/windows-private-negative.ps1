# Remove individual private-object checks; the matching rejection test must turn red.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Source mutations are only allowed in disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$source = Join-Path $root 'rust-spike/portability/src/windows_private.rs'
$original = [IO.File]::ReadAllText($source)
$mutations = @(
    @{ before = 'compare_acl(dacl, expected_acl)'; after = 'Ok(())'; test = 'rejects_broader_missing_duplicate_and_inherited_acl_entries' },
    @{ before = '|| (!directory && info.links != 1)'; after = ''; test = 'rejects_hard_links_and_wrong_object_types' }
)
try {
    foreach ($mutation in $mutations) {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p portability --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/private-negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        & "$PSScriptRoot/windows-child.ps1" -BuildReport '.rust-locks/private-negative-build.jsonl' -Filter $mutation.test -ExpectFailure
    }
} finally {
    [IO.File]::WriteAllText($source, $original)
}
