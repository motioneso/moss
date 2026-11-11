param(
    [Parameter(Mandatory)][string]$Bin,        # folder holding moss-db.exe and moss-shell.exe
    [Parameter(Mandatory)][string]$Postgres,   # database bundle with the vector extension
    [Parameter(Mandatory)][string]$Repo,       # repository root
    [Parameter(Mandatory)][string]$TestExe,    # moss-app test program
    [int]$Port = 5191
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
$gitOpenssl = 'C:\Program Files\Git\mingw64\bin'
if (-not (Test-Path (Join-Path $gitOpenssl 'openssl.exe'))) { throw 'No openssl found on this runner to stage' }
$shipped = Join-Path $install 'openssl'
New-Item -ItemType Directory -Path $shipped -Force | Out-Null
Copy-Item (Join-Path $gitOpenssl 'openssl.exe') $shipped
foreach ($dll in 'libssl-3-x64.dll', 'libcrypto-3-x64.dll', 'zlib1.dll') {
    $source = Join-Path $gitOpenssl $dll
    if (Test-Path $source) { Copy-Item $source $shipped }
}
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
        PATH = $cleanPath; MOSS_PROOF_NO_HOST_OPENSSL = '1'
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
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill($true) }
    Get-Process postgres, moss-shell, moss-db -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$work*" } | Stop-Process -Force
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$($user.SID.Value)'"
    if ($profile -and -not $profile.Loaded) { $profile | Remove-CimInstance }
    Remove-LocalUser -Name $account
}
