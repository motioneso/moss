param(
    [Parameter(Mandatory)][string]$MossDb,
    [Parameter(Mandatory)][string]$Postgres,
    [Parameter(Mandatory)][string]$Repo
)
# Runs init, up, status, restart and stop of the private database as a standard local account.
# GitHub's Windows runner is elevated and the product refuses to launch children from an
# elevated account, so the proof runs as a throwaway standard user.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-creating proof is only for disposable Windows GitHub runners'
}
$work = Join-Path (Split-Path $MossDb -Parent) 'supervisor-proof'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$inner = Join-Path $work 'inner.ps1'
@'
param($MossDb, $Postgres, $Repo, $Work)
$ErrorActionPreference = 'Stop'
$root = Join-Path $Work 'db'
function Run($what, [string[]]$arguments) {
    $out = & $MossDb @arguments 2>&1 | Out-String
    Write-Host "== $what (exit $LASTEXITCODE)"; Write-Host $out
    if ($LASTEXITCODE -ne 0) { throw "$what failed" }
    $out
}
Run 'init' @('init', '--root', $root, '--pg', $Postgres) | Out-Null
function Start-Up {
    $log = Join-Path $Work 'up.log'
    Remove-Item $log -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $MossDb -ArgumentList @('up', '--root', $root, '--pg', $Postgres, '--repo', $Repo) `
        -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Work 'up.err') -PassThru -WindowStyle Hidden
    for ($i = 0; $i -lt 240; $i++) {
        if (Test-Path $log) {
            $text = Get-Content $log -Raw
            if ($text -match '"event":\s*"ready"') { return $p }
            if ($text -match '"event":\s*"error"') { Write-Output $text; throw 'up reported an error' }
        }
        if ($p.HasExited) { Get-Content $log, (Join-Path $Work 'up.err') -ErrorAction SilentlyContinue; throw 'up exited early' }
        Start-Sleep -Milliseconds 500
    }
    throw 'up never became ready'
}
$first = Start-Up
$written = Run 'check with a marked row' @('check', '--root', $root, '--write', 'before-crash')
if ($written -notmatch 'before-crash') { throw 'the marked row was not stored' }
$status = Run 'status while running' @('status', '--root', $root) | ConvertFrom-Json
if (-not $status.supervisor_pid) { throw 'status shows no supervisor while running' }
Run 'stop' @('stop', '--root', $root) | Out-Null
if (-not $first.WaitForExit(60000)) { throw 'supervisor did not exit after stop' }
$after = Run 'status after stop' @('status', '--root', $root) | ConvertFrom-Json
if ($after.supervisor_pid) { throw 'status still shows a supervisor after stop' }
$second = Start-Up
$again = Run 'status after restart' @('status', '--root', $root) | ConvertFrom-Json
if (-not $again.supervisor_pid) { throw 'status shows no supervisor after restart' }
# Crash: end the supervisor without a stop request. The job object must take the whole database
# tree with it, and the next start must recover without help.
function Database-Processes { @(Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Postgres*" }) }
$before = (Database-Processes).Count
if ($before -lt 1) { throw 'no database processes while running' }
Write-Host "== crash: $before database processes, killing supervisor $($second.Id)"
Stop-Process -Id $second.Id -Force
$second.WaitForExit(30000) | Out-Null
$left = 99
for ($i = 0; $i -lt 60; $i++) { $left = (Database-Processes).Count; if ($left -eq 0) { break }; Start-Sleep -Milliseconds 500 }
Write-Host "== database processes left after the crash: $left"
if ($left -ne 0) { throw "database processes outlived the crashed supervisor ($left)" }
$third = Start-Up
$recovered = Run 'status after crash recovery' @('status', '--root', $root) | ConvertFrom-Json
if (-not $recovered.supervisor_pid) { throw 'status shows no supervisor after crash recovery' }
$survived = Run 'check after crash recovery' @('check', '--root', $root)
if ($survived -notmatch 'before-crash') { throw 'the marked row did not survive the crash' }
Run 'stop after crash recovery' @('stop', '--root', $root) | Out-Null
if (-not $third.WaitForExit(60000)) { throw 'supervisor did not exit after the post-crash stop' }
if ((Database-Processes).Count -ne 0) { throw 'database processes remain after the final stop' }
Write-Output 'WINDOWS SUPERVISOR PROOF: init, up, status, stop, restart, crash cleanup, crash recovery, stop all passed'
'@ | Set-Content $inner
$account = 'moss-db-proof'
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
$process = $null
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    foreach ($path in @($work, (Split-Path $Postgres -Parent), (Split-Path $MossDb -Parent), $Repo)) {
        & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
        if ($LASTEXITCODE -ne 0) { throw "Could not grant the proof account access to $path" }
    }
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $out = Join-Path $work 'inner.out'; $err = Join-Path $work 'inner.err'
    $temp = Join-Path $work 'temp'; New-Item -ItemType Directory -Path $temp -Force | Out-Null
    & icacls $temp /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
    $process = Start-Process -FilePath 'powershell.exe' -Credential $credential -LoadUserProfile `
        -WorkingDirectory $work -Environment @{ TEMP = $temp; TMP = $temp } `
        -ArgumentList @('-NoProfile', '-File', $inner, '-MossDb', $MossDb, '-Postgres', $Postgres, '-Repo', $Repo, '-Work', $work) `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    if (-not $process.WaitForExit(600000)) { $process.Kill($true); throw 'Supervisor proof exceeded ten minutes' }
    Get-Content $out; Get-Content $err
    if ($process.ExitCode -ne 0 -or -not (Select-String -Path $out -Pattern 'WINDOWS SUPERVISOR PROOF')) {
        Get-ChildItem $work -Recurse -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40 }
        throw "Supervisor proof failed ($($process.ExitCode))"
    }
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill($true) }
    Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$(Split-Path $Postgres -Parent)*" } | Stop-Process -Force
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($user.SID.Value)'"
    if ($profile -and -not $profile.Loaded) { $profile | Remove-CimInstance }
    Remove-LocalUser -Name $account
}
