param([Parameter(Mandatory)][string]$Bin, [Parameter(Mandatory)][string]$Postgres, [Parameter(Mandatory)][string]$Repo)
# Only the disposable CI wrapper is elevated; the product and gate run as a standard user.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows CI only' }
$work = Join-Path $env:RUNNER_TEMP 'service-standard-user'
New-Item -ItemType Directory $work | Out-Null
$account = 'moss-service-proof'
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    foreach ($path in @($work, $Bin, $Postgres, $Repo)) {
        & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
        if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture access' }
    }
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $python = (Get-Command python.exe).Source
    $runner = Join-Path $Repo 'rust-spike/shell/tools/phase7_instance_service.py'
    foreach ($negative in @($false, $true)) {
        $suffix = if ($negative) { 'negative' } else { 'positive' }
        $out = Join-Path $work "$suffix.out"
        $err = Join-Path $work "$suffix.err"
        $arguments = '"{0}" --bin "{1}" --postgres "{2}" --scratch "{3}" --port 5198' -f $runner, $Bin, $Postgres, (Join-Path $work $suffix)
        if ($negative) { $arguments += ' --negative-app-only' }
        Write-Host "COMMAND: python $arguments"
        $process = Start-Process $python -Credential $credential -LoadUserProfile -WorkingDirectory $work -ArgumentList $arguments -Environment @{RUSTUP_HOME=$env:RUSTUP_HOME} -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
        if (-not $process.WaitForExit(900000)) { $process.Kill($true); throw 'Service proof exceeded its deadline' }
        Get-Content $out -Tail 80
        Get-Content $err -Tail 40
        Write-Host "EXIT: $($process.ExitCode)"
        $expected = if ($negative) { 1 } else { 0 }
        if ($process.ExitCode -ne $expected) { throw "Service $suffix proof failed" }
        if ($negative -and -not (Select-String -Path $err -SimpleMatch 'server returns after service manager restart without app')) { throw 'Negative control failed before the login assertion' }
    }
} finally {
    Get-ScheduledTask -TaskName 'moss-server-*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
    Remove-LocalUser -Name $account
}
