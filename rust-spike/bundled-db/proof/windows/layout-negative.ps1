# Each mutation must turn one canonical layout integration test red on a standard account.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Source mutations are only allowed in disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../../..").Path
$mutations = @(
    @{ file = 'layout/windows.rs'; before = 'let secrets = child("secrets")?;'; after = 'let secrets = child("logs")?;'; test = 'canonical_passwords_reopen_without_replacement_and_reject_escape'; assertion = 'credential directory must be canonical secrets' },
    @{ file = 'layout/windows.rs'; before = 'super::read_bounded(self.windows.run.open_file(OsStr::new("state.json"))?, 65536)'; after = 'std::fs::read_to_string(self.state_file())'; test = 'planted_state_and_password_files_are_refused'; assertion = 'unvalidated state must be refused' },
    @{ file = 'layout.rs'; before = 'self.windows.secrets.open_file(std::ffi::OsStr::new(role))?'; after = 'std::fs::File::open(self.secrets.join(role))?'; test = 'planted_state_and_password_files_are_refused'; assertion = 'unvalidated credential must be refused' }
)
foreach ($mutation in $mutations) {
    $source = Join-Path $root ('rust-spike/bundled-db/src/' + $mutation.file)
    $original = [IO.File]::ReadAllText($source)
    try {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p bundled-db --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/layout-negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        & "$root/rust-spike/portability/proof/windows-child.ps1" -BuildReport '.rust-locks/layout-negative-build.jsonl' -TestTarget bundled_db -Filter $mutation.test -ExpectFailure -ExpectedFailurePattern $mutation.assertion
    } finally {
        [IO.File]::WriteAllText($source, $original)
    }
}
