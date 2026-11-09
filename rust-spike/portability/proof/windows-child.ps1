param(
    [string]$BuildReport = '.rust-locks/child-build.jsonl',
    [string]$Filter = 'windows_child',
    [string]$TestTarget = 'portability',
    [string]$ExpectedSummary = 'test result: ok\. 8 passed; 0 failed; 1 ignored',
    [string]$ExpectedFailurePattern = '',
    [switch]$ExpectFailure
)
# GitHub's Windows runner is elevated. Exercise the actual test binary as a separate standard
# local account; do not weaken the product's elevation refusal just to accommodate CI.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-creating qualification script is only for disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$state = Join-Path $root '.rust-locks'
$account = 'moss-child-proof'
$binary = Get-Content (Join-Path $root $BuildReport) | ForEach-Object {
    $entry = $_ | ConvertFrom-Json
    if ($entry.reason -eq 'compiler-artifact' -and $entry.target.name -eq $TestTarget -and $entry.executable) {
        $entry.executable
    }
} | Select-Object -Last 1
if (-not $binary) { throw 'No compiled test binary was reported by Cargo' }
# This random password is used only to create/log on the disposable CI account. Never print it
# or write it to disk. No project credential is involved.
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    # The standard account needs only this throwaway CI checkout and its temporary files.
    & icacls $root /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the proof account access to the checkout' }
    $temp = Join-Path $state 'standard-user-temp'
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $out = Join-Path $state 'windows-child.out'
    $err = Join-Path $state 'windows-child.err'
    $process = Start-Process -FilePath $binary -ArgumentList @($Filter, '--nocapture', '--test-threads=1') `
        -Credential $credential -LoadUserProfile -WorkingDirectory $root `
        -Environment @{ TEMP = $temp; TMP = $temp } `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    if (-not $process.WaitForExit(180000)) {
        $process.Kill($true)
        throw 'Windows child qualification exceeded three minutes'
    }
    Get-Content $out
    Get-Content $err
    if ($ExpectFailure) {
        if ($process.ExitCode -eq 0 -or -not (Select-String -Path $out -Pattern 'test result: FAILED. 0 passed; 1 failed')) {
            throw 'Negative control did not produce the expected test failure'
        }
        if ($ExpectedFailurePattern -and -not (Select-String -Path $out, $err -Pattern $ExpectedFailurePattern)) {
            throw 'Negative control failed outside its intended assertion'
        }
        Write-Output 'Negative control: expected failure observed.'
    } elseif ($process.ExitCode -ne 0 -or -not (Select-String -Path $out -Pattern $ExpectedSummary)) {
        throw "Windows child qualification failed or did not run the complete suite ($($process.ExitCode))"
    }
} finally {
    & icacls $root /remove:g ('*' + $user.SID.Value) /Q
    Remove-LocalUser -Name $account
}
