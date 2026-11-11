param(
    [Parameter(Mandatory)][string]$Bin,        # folder holding moss-db.exe and moss-shell.exe
    [Parameter(Mandatory)][string]$Postgres,   # database bundle with the vector extension
    [Parameter(Mandatory)][string]$Repo,       # repository root
    [Parameter(Mandatory)][string]$TestExe,    # moss-app test program
    [int]$Port = 5191,
    [string]$AppExe = ''             # the moss-app program; when given, its own buttons are driven too
)
# Stages a Windows install, then runs the app's own setup, start, stop and restart as a throwaway
# standard user (the product refuses to launch children from an elevated account).
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-creating proof is only for disposable Windows GitHub runners'
}
$work = Join-Path $Bin 'lifecycle-proof'
$install = Join-Path $work 'install'
New-Item -ItemType Directory -Path $install -Force | Out-Null
foreach ($name in 'moss-db.exe', 'moss-shell.exe') { Copy-Item (Join-Path $Bin $name) $install }
if ($AppExe) { Copy-Item $AppExe $install }
Copy-Item $Postgres (Join-Path $install 'postgres') -Recurse
New-Item -ItemType Directory -Path (Join-Path $install 'web') -Force | Out-Null
Set-Content (Join-Path $install 'web\index.html') '<!doctype html><title>Moss</title>'
# The same schema folders the database supervisor migrates from.
$source = Get-Content (Join-Path $Repo 'rust-spike/bundled-db/src/migrate.rs') -Raw
$folders = [regex]::Match($source, 'pub const FOLDERS:.*?= \[(.*?)\];', 'Singleline').Groups[1].Value
$names = [regex]::Matches($folders, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$names += [regex]::Match($source, 'const BOOTSTRAP: &str = "([^"]+)";').Groups[1].Value
foreach ($folder in $names) {
    $target = Join-Path $install "schema\$folder"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem (Join-Path $Repo $folder) -File | Where-Object { $_.Extension -in '.sql', '.mjs' } | Copy-Item -Destination $target
}
# Ship an OpenSSL inside the install, the way a real Windows install does. Git's copy is only
# the source of the files here. The proof account's search path then has no OpenSSL at all, so
# setup can only succeed with the shipped one.
$candidates = @('C:\Program Files\Git\mingw64\bin', 'C:\Program Files\Git\usr\bin')
$found = Get-Command openssl.exe -All -ErrorAction SilentlyContinue | ForEach-Object { Split-Path $_.Source }
$gitOpenssl = @($candidates + $found) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'openssl.exe')) } | Select-Object -First 1
if (-not $gitOpenssl) { throw 'No openssl found on this runner to stage' }
Write-Host "staging openssl from $gitOpenssl"
$shipped = Join-Path $install 'openssl'
New-Item -ItemType Directory -Path $shipped -Force | Out-Null
Copy-Item (Join-Path $gitOpenssl 'openssl.exe') $shipped
# Every library beside it, so the copy runs without that folder on the search path.
Get-ChildItem $gitOpenssl -Filter '*.dll' | Copy-Item -Destination $shipped
Set-Content (Join-Path $shipped 'openssl.cnf') '# Moss local certificate generation uses the default provider.'
$cleanPath = ($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'openssl.exe')) }) -join ';'
Write-Host "search path entries removed because they hold an openssl: $((($env:PATH -split ';').Count) - (($cleanPath -split ';').Count))"

$account = 'moss-app-proof'
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'aA1!') -AsPlainText -Force
$user = New-LocalUser -Name $account -Password $password -AccountNeverExpires
$process = $null
try {
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    $temp = Join-Path $work 'temp'; New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $data = Join-Path $work 'data'   # the app creates it; the test asserts it starts absent
    foreach ($path in @($work, $temp)) {
        & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)M') /Q
        if ($LASTEXITCODE -ne 0) { throw "Could not grant the proof account access to $path" }
    }
    foreach ($path in @((Split-Path $TestExe -Parent), $Repo)) {
        & icacls $path /grant ('*' + $user.SID.Value + ':(OI)(CI)RX') /Q
    }
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $password)
    $out = Join-Path $work 'proof.out'; $err = Join-Path $work 'proof.err'
    $environment = @{
        TEMP = $temp; TMP = $temp
        MOSS_CLEAN_INSTALL = $install; MOSS_CLEAN_DATA = $data; MOSS_PROOF_PORT = "$Port"
        PATH = $cleanPath; MOSS_PROOF_CLEAN_PATH = $cleanPath; MOSS_PROOF_NO_HOST_OPENSSL = '1'
    }
    function Run-Proof($testName, $marker, $suffix) {
        $out = Join-Path $work "proof-$suffix.out"; $err = Join-Path $work "proof-$suffix.err"
        $environment['MOSS_CLEAN_DATA'] = Join-Path $work "data-$suffix"
        $environment['MOSS_PROOF_PORT'] = "$($Port + $(if ($suffix -eq 'lan') { 1 } else { 0 }))"
        $process = Start-Process -FilePath $TestExe -Credential $credential -LoadUserProfile -WorkingDirectory $work `
            -Environment $environment `
            -ArgumentList @('--ignored', '--exact', $testName, '--nocapture') `
            -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
        $script:process = $process
        if (-not $process.WaitForExit(900000)) { $process.Kill($true); throw "$suffix proof exceeded fifteen minutes" }
        Get-Content $out; Get-Content $err
        if ($process.ExitCode -ne 0 -or -not (Select-String -Path $out -Pattern $marker)) {
            Get-ChildItem $environment['MOSS_CLEAN_DATA'] -Recurse -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object { Write-Output "--- $($_.FullName)"; Get-Content $_.FullName -Tail 40 }
            throw "$suffix proof failed ($($process.ExitCode))"
        }
    }
    Run-Proof 'windows_proof::windows_app_provisions_starts_stops_and_restarts_the_whole_server' 'WINDOWS APP LIFECYCLE PROOF' 'lifecycle'
    Write-Host '== firewall profiles on this runner'
    Get-NetFirewallProfile | Select-Object Name, Enabled | Format-Table | Out-String | Write-Host
    Run-Proof 'windows_proof::windows_server_answers_on_the_network_address_only_when_sharing_is_on' 'WINDOWS NETWORK ADDRESS PROOF' 'lan'
    if ($AppExe) {
        # Buttons proof: the real app window, driven as the same standard user.
        $buttonsData = Join-Path $work 'data-buttons'
        $buttonsOut = Join-Path $work 'buttons.out'; $buttonsErr = Join-Path $work 'buttons.err'
        $inner = Join-Path $PSScriptRoot 'windows-buttons-inner.ps1'
        & icacls $PSScriptRoot /grant ('*' + $user.SID.Value + ':(OI)(CI)RX') /Q | Out-Null
        $buttons = Start-Process -FilePath 'powershell.exe' -Credential $credential -LoadUserProfile -WorkingDirectory $work `
            -Environment @{ TEMP = $temp; TMP = $temp } `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $inner, '-Install', $install, '-Data', $buttonsData, '-Work', $work) `
            -RedirectStandardOutput $buttonsOut -RedirectStandardError $buttonsErr -PassThru
        $script:process = $buttons
        if (-not $buttons.WaitForExit(1200000)) { & taskkill.exe /PID $buttons.Id /T /F | Out-Null; throw 'Buttons proof exceeded twenty minutes' }
        Get-Content $buttonsOut; Get-Content $buttonsErr -ErrorAction SilentlyContinue
        Get-Content (Join-Path $work 'app.err') -Tail 40 -ErrorAction SilentlyContinue
        if ($buttons.ExitCode -ne 0 -or -not (Select-String -Path $buttonsOut -Pattern 'WINDOWS APP BUTTONS PROOF')) { throw "Buttons proof failed ($($buttons.ExitCode))" }
    }
} finally {
    if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
    Get-Process postgres, moss-shell, moss-db -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$work*" } | Stop-Process -Force
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($user.SID.Value)'"
    if ($profile -and -not $profile.Loaded) { $profile | Remove-CimInstance }
    Remove-LocalUser -Name $account
}
