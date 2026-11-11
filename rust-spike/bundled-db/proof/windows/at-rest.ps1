param(
    [Parameter(Mandatory)][string]$MossDb
)
# Runs the disk-encryption check once as the runner's administrator and once as a throwaway
# standard user, and prints both answers side by side. The runner's disk is not encrypted, so
# the proof is that each run answers in the plain three-way form and says why.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-creating proof is only for disposable Windows GitHub runners'
}
$work = Join-Path (Split-Path $MossDb -Parent) 'at-rest-proof'
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Show($label, $json) {
    $report = $json | ConvertFrom-Json
    if ($report.status -notin 'verified', 'off', 'unknown') { throw "$label gave no plain status" }
    foreach ($item in 'Data', 'Swap', 'Crash dumps') {
        if (-not ($report.checks | Where-Object { $_.item -eq $item })) { throw "$label has no '$item' check" }
    }
    Write-Host "== $label : status $($report.status), claim protection $($report.claim_protection)"
    Write-Host $report.message
    foreach ($check in $report.checks) {
        Write-Host ("   {0,-12} {1,-8} {2}" -f $check.item, $check.status, ($check.evidence -join ' | '))
    }
    $report
}

$adminJson = & $MossDb at-rest --path "Data=$work" | Out-String
if ($LASTEXITCODE -ne 0) { throw "administrator run failed: $adminJson" }
$admin = Show 'administrator' $adminJson

$account = 'moss-rest-proof'
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    foreach ($path in @($work)) { & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q | Out-Null }
    & icacls (Split-Path $MossDb -Parent) /grant ('*' + $user.SID.Value + ':(OI)(CI)RX') /Q | Out-Null
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $out = Join-Path $work 'standard.out'; $err = Join-Path $work 'standard.err'
    $process = Start-Process -FilePath $MossDb -Credential $credential -LoadUserProfile -WorkingDirectory $work `
        -ArgumentList @('at-rest', '--path', "Data=$work") -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    if (-not $process.WaitForExit(600000)) { $process.Kill($true); throw 'standard-user run hung' }
    if ($process.ExitCode -ne 0) { Get-Content $err; throw "standard-user run failed ($($process.ExitCode))" }
    $standard = Show 'standard user' (Get-Content $out -Raw)
    # What a standard user may and may not conclude.
    if ($standard.claim_protection -and -not $admin.claim_protection) {
        throw 'a standard user claimed protection that the administrator run did not'
    }
    Write-Host 'WINDOWS AT-REST PROOF: administrator and standard user both answered in the plain form'
} finally {
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($user.SID.Value)'"
    if ($profile -and -not $profile.Loaded) { $profile | Remove-CimInstance }
    Remove-LocalUser -Name $account
}
