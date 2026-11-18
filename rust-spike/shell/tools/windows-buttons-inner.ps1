param(
    [Parameter(Mandatory)][string]$Install,
    [Parameter(Mandatory)][string]$Data,
    [Parameter(Mandatory)][string]$Work,
    [int]$DebugPort = 9333
)
# Runs as the throwaway standard user. Starts the real app window, then drives its own screens
# through the browser engine's debugging port: real buttons, real page, real server.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This proof starts and stops processes and runs only on a GitHub Windows runner'
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort --remote-allow-origins=*"
$folder = Join-Path $Data 'servers\default'

function Log($text) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $text) }

$app = Start-Process -FilePath (Join-Path $Install 'moss-app.exe') -ArgumentList @('--data', $Data, '--install', $Install) `
    -RedirectStandardOutput (Join-Path $Work 'app.out') -RedirectStandardError (Join-Path $Work 'app.err') -PassThru
Log "app started as process $($app.Id)"

$script:ws = $null
$script:next = 0
function Cdp($method, $params = @{}) {
    $script:next++
    $id = $script:next
    $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $null = $script:ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 65536
    while ($true) {
        $text = ''
        do {
            $result = $script:ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
            $text += [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        } until ($result.EndOfMessage)
        $message = $text | ConvertFrom-Json
        if ($message.id -eq $id) {
            if ($message.error) { throw "CDP $method failed: $($message.error.message)" }
            return $message.result
        }
    }
}
function Eval($expression) {
    (Cdp 'Runtime.evaluate' @{ expression = $expression; returnByValue = $true }).result.value
}
function Screen { Eval 'document.body ? document.body.dataset.screen || "" : ""' }

function Connect-Page {
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json" -TimeoutSec 2
            $page = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -like '*moss-app*' })[0]
            if (-not $page) { $page = @($targets | Where-Object { $_.type -eq 'page' })[0] }
            if ($page) {
                $script:ws = [Net.WebSockets.ClientWebSocket]::new()
                $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
                Log "attached to the app's own page: $($page.url)"
                return
            }
        } catch { }
        if ($app.HasExited) { throw 'the app exited before its window could be driven' }
        Start-Sleep -Milliseconds 500
    }
    $script:noPort = $true
    throw 'the app window never offered a debugging port'
}
function Wait-Screen($want, $seconds = 90) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        $now = Screen
        if ($now -eq $want) { Log "screen: $want"; return }
        Start-Sleep -Milliseconds 500
    }
    $text = Eval 'document.body ? document.body.innerText : ""'
    throw "never reached screen '$want' (now '$(Screen)'): $text"
}
# A real pointer press and release at the middle of the button with this exact label.
function Click($label) {
    $box = Eval "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(`"$label`")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"
    if (-not $box) { throw "no button labelled '$label' on screen '$(Screen)'" }
    foreach ($type in 'mouseMoved', 'mousePressed', 'mouseReleased') {
        $null = Cdp 'Input.dispatchMouseEvent' @{ type = $type; x = $box.x; y = $box.y; button = 'left'; clickCount = 1 }
    }
    Log "clicked '$label'"
}
function Server-Pid {
    $file = Join-Path $folder 'running.json'
    if (-not (Test-Path $file)) { return $null }
    try { (Get-Content $file -Raw | ConvertFrom-Json).pid } catch { $null }
}
function Wait-ServerUp($seconds = 180) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        $p = Server-Pid
        if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
            $running = Get-Content (Join-Path $folder 'running.json') -Raw | ConvertFrom-Json
            $port = ([Uri]$running.origin).Port
            if ((Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded) { return $p }
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'the server never came up'
}
function Wait-ServerGone($oldPid, $seconds = 120) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
            $db = & (Join-Path $Install 'moss-db.exe') status --root (Join-Path $folder 'database') | ConvertFrom-Json
            if (-not $db.supervisor_pid) { return }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "server $oldPid or its database is still running"
}
# The same file the notifier uses to ask a running window for a server it does not know shows
# the Servers screen, where Stop and Open live.
function Show-Servers {
    '{"server":"none","path":null}' | Set-Content (Join-Path $Data 'open-request.json') -NoNewline
    Wait-Screen 'servers'
}

try {
    Connect-Page
    Wait-Screen 'first-run' 120
    Click 'This computer'
    $first = Wait-ServerUp
    Log "BUTTON 'This computer': set up and started the server, process $first"

    Show-Servers
    Click 'Stop'
    Wait-Screen 'confirm-stop'
    Click 'Stop server'
    Wait-ServerGone $first
    Log "BUTTONS 'Stop' and 'Stop server': server $first and its database are gone"

    Wait-Screen 'servers' 60
    Click 'Open'
    $second = Wait-ServerUp
    Log "BUTTON 'Open': the stopped server started again as process $second"

    Show-Servers
    Click 'Stop'
    Wait-Screen 'confirm-stop'
    Click 'Stop server'
    Wait-ServerGone $second
    Wait-Screen 'servers' 60
    Click 'Open'
    $third = Wait-ServerUp
    if ($third -eq $second) { throw 'restart reused the old process' }
    Log "RESTART through the buttons: server $second replaced by $third"

    Show-Servers
    Click 'Stop'
    Wait-Screen 'confirm-stop'
    Click 'Stop server'
    Wait-ServerGone $third
    Log 'WINDOWS APP BUTTONS PROOF: This computer, Stop, Open and a restart all worked through the real window'
} catch {
    Log "FAILED: $($_.Exception.Message)"
    Log "app exited: $($app.HasExited)"
    foreach ($f in 'app.out', 'app.err') { $p = Join-Path $Work $f; if (Test-Path $p) { Log "--- $f"; Get-Content $p -Tail 30 } }
    Log '--- ports held by the app and its web engine'
    $ids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'moss|msedgewebview2' } | ForEach-Object { $_.Id })
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object { "{0}:{1} pid {2}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess }
    Log '--- what the debugging port answers'
    try { (Invoke-WebRequest "http://127.0.0.1:$DebugPort/json" -UseBasicParsing -TimeoutSec 3).Content.Substring(0, 400) } catch { "no answer: $($_.Exception.Message)" }
    Log '--- DevToolsActivePort file and netstat'
    $dt = Join-Path $Install 'moss-app.exe.WebView2\EBWebView\DevToolsActivePort'
    if (Test-Path $dt) { Get-Content $dt } else { 'no DevToolsActivePort file' }
    & netstat.exe -ano | Select-String 'LISTENING' | Select-String '127.0.0.1|\[::1\]' | Select-Object -First 25
    foreach ($h in 'localhost', '[::1]') { try { "$h answers: " + (Invoke-WebRequest "http://${h}:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 3).StatusCode } catch { "$h no answer" } }
    Log '--- browser policies that could switch debugging off'
    foreach ($k in 'HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2', 'HKLM:\SOFTWARE\Policies\Microsoft\EdgeWebView', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge') {
        if (Test-Path $k) { "$k : " + ((Get-ItemProperty $k | Out-String).Trim() -replace '\s+', ' ') } else { "$k : none" }
    }
    Log '--- user data folder'
    Get-ChildItem (Join-Path $Install 'moss-app.exe.WebView2\EBWebView') -ErrorAction SilentlyContinue | Select-Object -First 15 | ForEach-Object { $_.Name }
    Log '--- web engine command lines'
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Select-Object -First 2 | ForEach-Object { $_.CommandLine.Substring(0, [Math]::Min(500, $_.CommandLine.Length)) }
    Log '--- processes'
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'moss|webview|msedge' } | ForEach-Object { "$($_.Name) $($_.Id)" }
    if ($script:noPort) { Log 'WINDOWS APP BUTTONS PROOF: NOT RUN, the web engine never opened its debugging port'; $script:exitCode = 3 } else { $script:exitCode = 1; throw }
} finally {
    if (-not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F | Out-Null }
    Get-Process postgres, moss-shell, moss-db -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" } | Stop-Process -Force
}
if ($script:exitCode) { exit $script:exitCode }
