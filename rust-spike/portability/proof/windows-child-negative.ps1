# Mutation controls: the lifecycle/handle tests must reject removal of their protections.
# Run only on the disposable Windows CI checkout, after the normal standard-account run.
$ErrorActionPreference = 'Stop'
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
    }
)
try {
    foreach ($mutation in $mutations) {
        if (-not $original.Contains($mutation.before)) { throw 'Mutation target changed; update the negative control' }
        [IO.File]::WriteAllText($source, $original.Replace($mutation.before, $mutation.after))
        cargo +1.95.0 test --locked --manifest-path (Join-Path $root 'rust-spike/Cargo.toml') -p portability --lib --no-run --message-format=json > (Join-Path $root '.rust-locks/negative-build.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'Negative-control build failed' }
        Write-Output "Negative control: $($mutation.test)"
        & "$PSScriptRoot/windows-child.ps1" -BuildReport '.rust-locks/negative-build.jsonl' -Filter $mutation.test -ExpectFailure
    }
} finally {
    [IO.File]::WriteAllText($source, $original)
}
