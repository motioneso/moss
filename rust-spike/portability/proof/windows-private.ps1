# Actual Windows ACL enforcement with two different standard local accounts. No project secret.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-creating proof is only for disposable Windows GitHub runners'
}
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
$state = Join-Path $root '.rust-locks'
$binary = Get-Content (Join-Path $state 'child-build.jsonl') | ForEach-Object {
    $entry = $_ | ConvertFrom-Json
    if ($entry.reason -eq 'compiler-artifact' -and $entry.target.name -eq 'portability' -and $entry.executable) {
        $entry.executable
    }
} | Select-Object -Last 1
if (-not $binary) { throw 'No compiled portability tests found' }
$users = @()
$credentials = @()
$fixture = Join-Path $state 'private-cross-account'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
function Invoke-Proof([int]$Account, [string]$Test, [bool]$Ignored = $false) {
    $out = Join-Path $state "private-$Account.out"
    $err = Join-Path $state "private-$Account.err"
    $arguments = @($Test, '--nocapture', '--test-threads=1')
    $expected = 'test result: ok\. 13 passed; 0 failed; 3 ignored'
    if ($Ignored) { $arguments += @('--ignored', '--exact'); $expected = 'test result: ok\. 1 passed; 0 failed' }
    $process = Start-Process -FilePath $binary -ArgumentList $arguments -Credential $credentials[$Account] `
        -LoadUserProfile -WorkingDirectory $root -Environment @{ TEMP = $fixture; TMP = $fixture; MOSS_PRIVATE_PROOF = $fixture } `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'Private-file proof timed out' }
    Get-Content $out
    Get-Content $err
    if ($process.ExitCode -ne 0 -or -not (Select-String -Path $out -Pattern $expected)) {
        throw "Private-file proof failed or incomplete: $Test ($($process.ExitCode))"
    }
}
try {
    foreach ($name in @('moss-private-owner', 'moss-private-other')) {
        # Never print or persist these disposable CI account passwords.
        $password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
        $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires
        $users += $user
        Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
        & icacls $root /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant checkout access' }
        $credentials += [pscredential]::new("$env:COMPUTERNAME\$name", $password)
    }
    Invoke-Proof 0 'windows_private'
    Invoke-Proof 0 'windows_private::tests::owner_creates_cross_account_fixture' $true
    Invoke-Proof 1 'windows_private::tests::other_account_is_denied_by_windows' $true
} finally {
    # Clean up as the owner: the elevated runner itself is intentionally absent from private ACLs.
    try {
        if ($credentials.Count -gt 0) {
            Invoke-Proof 0 'windows_private::tests::owner_removes_cross_account_fixture' $true
        }
    } finally {
        foreach ($user in $users) {
            & icacls $root /remove:g ('*' + $user.SID.Value) /Q
            Remove-LocalUser -Name $user.Name
        }
        Remove-Item $fixture -Recurse -Force
    }
}
