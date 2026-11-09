# Each mutation must fail at its intended assertion under the standard proof account.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Source mutations are only allowed in disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../../..").Path
$mutations = @(
    @{ file = 'supervisor_lock.rs'; before = '!portability::file_lock::try_exclusive(&file).map_err(|e| format!("lock file: {e}"))?'; after = 'false'; test = 'canonical_lock_serializes_handles_and_processes_without_truncating_pid'; assertion = 'second handle must see the held lock' },
    @{ file = 'layout/windows.rs'; before = 'root.open_file(name)'; after = 'std::fs::OpenOptions::new().read(true).write(true).open(root.path().join(name))'; test = 'windows_lock_rejects_planted_nonprivate_file_without_modifying_it'; assertion = 'unvalidated lock must be refused' },
    @{ file = 'layout/windows.rs'; before = 'self.lock != root.path().join("moss-db.lock")'; after = 'false'; test = 'windows_lock_rejects_redirected_public_path'; assertion = 'redirected lock path must be refused' }
)
foreach ($mutation in $mutations) {
    $source = Join-Path $root ('rust-spike/bundled-db/src/' + $mutation.file)
    $original = [IO.File]::ReadAllText($source)
    try {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p bundled-db --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/lock-negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        & "$root/rust-spike/portability/proof/windows-child.ps1" -BuildReport '.rust-locks/lock-negative-build.jsonl' -TestTarget bundled_db -Filter $mutation.test -ExpectFailure -ExpectedFailurePattern $mutation.assertion
    } finally {
        [IO.File]::WriteAllText($source, $original)
    }
}
