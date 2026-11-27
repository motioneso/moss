param([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string]$Postgres)

# GitHub's Windows runner is elevated and the database refuses an administrator. Only this
# disposable wrapper is elevated; the runner and the negative controls run as a standard user.

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows CI only' }
$work = Join-Path $env:RUNNER_TEMP 'backup-standard-user'
New-Item -ItemType Directory $work | Out-Null
$account = 'moss-backup-proof'

# Random logon password for the disposable account only. Never printed or written to disk.

$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user

    # The controls rebuild patched binaries, so the account needs the toolchain and target too.
    # The workflow sets RUSTUP_HOME from bash, so rustup reports the native path.

    $rustupHome = (& rustup show home).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $rustupHome)) { throw 'Could not resolve the rustup home' }
    $cargoHome = Join-Path $env:USERPROFILE '.cargo'
    foreach ($path in @($work, $Repo, $Postgres, $env:CARGO_TARGET_DIR, $rustupHome, $cargoHome)) {
        & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
        if ($LASTEXITCODE -ne 0) { throw "Could not grant fixture access to $path" }
    }
    $temp = Join-Path $work 'temp'
    New-Item -ItemType Directory $temp | Out-Null
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $python = (Get-Command python.exe).Source
    $tools = Join-Path $Repo 'rust-spike/backup/tools'
    $steps = @(
        @{ name = 'runner'; args = '"{0}" --postgres "{1}" --scratch "{2}"' -f (Join-Path $tools 'phase7_backup_engine.py'), $Postgres, (Join-Path $work 'proof'); expect = 'phase7_backup_engine PASS' },
        @{ name = 'controls'; args = '"{0}" -- --postgres "{1}" --scratch "{2}"' -f (Join-Path $tools 'backup_negative_controls.py'), $Postgres, (Join-Path $work 'negative'); expect = 'backup negative controls PASS' }
    )
    foreach ($step in $steps) {
        $out = Join-Path $work "$($step.name).out"
        $err = Join-Path $work "$($step.name).err"
        Write-Host "COMMAND: python $($step.args)"
        $process = Start-Process $python -Credential $credential -LoadUserProfile -WorkingDirectory $Repo -ArgumentList $step.args `
            -Environment @{ RUSTUP_HOME = $rustupHome; CARGO_HOME = $cargoHome; TEMP = $temp; TMP = $temp } `
            -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
        if (-not $process.WaitForExit(5400000)) { $process.Kill($true); throw "Backup $($step.name) exceeded its deadline" }
        Get-Content $out -Tail 80
        Get-Content $err -Tail 40
        Write-Host "EXIT: $($process.ExitCode)"
        if ($process.ExitCode -ne 0) { throw "Backup $($step.name) failed" }
        if (-not (Select-String -Path $out -SimpleMatch $step.expect)) { throw "Backup $($step.name) did not report a pass" }
    }
} finally {
    Remove-LocalUser -Name $account
}
