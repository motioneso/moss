# Mutation controls: the lifecycle/handle tests must reject removal of their protections.
# Run only on the disposable Windows CI checkout, after the normal standard-account run.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Source mutations are only allowed in disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$source = Join-Path $root 'rust-spike/portability/src/windows_child.rs'
$original = [IO.File]::ReadAllText($source)
$mutations = @(
    @{
        before = 'limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;'
        after = 'limits.basic.flags = 0;'
        test = 'dropping_child_ends_root_and_descendant_but_leaves_other_jobs_alone'
    },
    @{
        before = 'startup.attributes = attributes.pointer();'
        after = 'startup.attributes = null_mut();'
        test = 'child_inherits_only_selected_standard_handles'
    },
    @{
        before = '.filter(|(key, _)| !key.to_string_lossy().to_ascii_uppercase().starts_with("PG"))'
        after = '.filter(|_| true)'
        test = 'database_environment_is_removed_and_console_is_windowless'
    },
    @{
        before = '| CREATE_NO_WINDOW'
        after = ''
        test = 'database_environment_is_removed_and_console_is_windowless'
    },
    @{
        before = 'require_standard_user()?;'
        after = '// Negative control removes elevation refusal.'
        test = 'windows_child::tests::elevated_launch_is_refused'
        elevated = $true
    }
)
try {
    foreach ($mutation in $mutations) {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p portability --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        Write-Output "Negative control: $($mutation.test)"
        if ($mutation.elevated) {
            $binary = Get-Content (Join-Path $root '.rust-locks/negative-build.jsonl') | ForEach-Object {
                $entry = $_ | ConvertFrom-Json
                if ($entry.reason -eq 'compiler-artifact' -and $entry.target.name -eq 'portability' -and $entry.executable) { $entry.executable }
            } | Select-Object -Last 1
            if (-not $binary) { throw 'No elevated negative-control binary was built' }
            $out = Join-Path $root '.rust-locks/elevated-negative.out'
            $err = Join-Path $root '.rust-locks/elevated-negative.err'
            $process = Start-Process -FilePath $binary -ArgumentList @($mutation.test, '--ignored', '--exact', '--nocapture') `
                -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
            if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'Elevated negative control timed out' }
            Get-Content $out
            Get-Content $err
            if ($process.ExitCode -eq 0 -or -not (Select-String -Path $out -Pattern 'test result: FAILED. 0 passed; 1 failed')) {
                throw 'Removing elevation refusal did not make its test fail'
            }
            Write-Output 'Negative control: expected failure observed.'
        } else {
            & "$PSScriptRoot/windows-child.ps1" -BuildReport '.rust-locks/negative-build.jsonl' -Filter $mutation.test -ExpectFailure
        }
    }
} finally {
    [IO.File]::WriteAllText($source, $original)
}
