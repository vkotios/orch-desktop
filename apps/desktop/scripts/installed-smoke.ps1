#Requires -Version 5.1
<#
.SYNOPSIS
  CI-only installed NSIS app smoke: silent-install the exact NSIS candidate into an
  owned directory, launch the installed cho-desktop.exe --native-host-smoke with a
  sanitized child environment, verify the real CHO_HOST_SMOKE receipt and owned host
  shutdown, then silently uninstall only the owned install.

.DESCRIPTION
  CI installed-smoke. NOT a clean-machine, WebView2 UI, real-provider,
  upgrade/migration, MSI, or signed-release qualification. The Windows runner has
  developer tooling; hiding PATH entries does not make it clean.

  Fail-closed: any unexpected state fails instead of passing. Uncertain resources
  and evidence are kept rather than claimed PASS.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [int]$InstallTimeoutSec = 600,
  [int]$SmokeTimeoutSec = 120,
  [int]$UninstallTimeoutSec = 300
)

$ErrorActionPreference = 'Stop'

$Label = 'CI installed-smoke'
$Limits = 'CI installed-smoke only: not a clean-machine, WebView2 UI, real-provider, upgrade/migration, MSI, or signed-release qualification. Windows runner has developer tooling; PATH hiding does not make it clean. Native smoke covers bundled host boot/ping/shutdown only, never a provider conversation.'

function Fail([string]$Message) {
  Write-Error "$Label FAIL: $Message"
  exit 1
}

# --- Fail-closed CI guard: installer execution is CI-only and explicit opt-in. ---
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  Fail 'refusing to run: requires GITHUB_ACTIONS=true, RUNNER_OS=Windows, and RUNNER_TEMP set (installer execution is CI-only; this host is not a CI Windows runner; nothing was executed)'
}

$installerPath = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  Fail "installer not found: $installerPath"
}

if (Test-Path -LiteralPath $OutputDir) {
  Fail "output directory already exists, refusing to reuse: $OutputDir"
}
New-Item -ItemType Directory -Path $OutputDir | Out-Null
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

$stdoutLog = Join-Path $OutputDir 'smoke.stdout.log'
$stderrLog = Join-Path $OutputDir 'smoke.stderr.log'
$resultPath = Join-Path $OutputDir 'installed-smoke.json'

$result = [ordered]@{
  label        = $Label
  verdict      = 'FAIL'
  limits       = $Limits
  installer    = [ordered]@{ path = $installerPath }
  installDir   = $null
  appExe       = $null
  runtimeNode  = $null
  receipt      = $null
  appExit      = $null
  hostGone     = $false
  uninstall    = [ordered]@{ attempted = $false; appAbsent = $false }
  cleanup      = [ordered]@{ ownedRootRemoved = $false; ownedRoot = $null }
  error        = $null
}

function Write-Result {
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding utf8
}

function Test-Contained([string]$Child, [string]$Parent) {
  $c = [IO.Path]::GetFullPath($Child).TrimEnd([IO.Char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  $p = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  return ($c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase) -and ($c.Length -gt $p.Length))
}

$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$ownedRoot = Join-Path $runnerTemp ('cho-installed-smoke-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $ownedRoot 'app'
$emptyCwd = Join-Path $ownedRoot 'cwd'
$result.cleanup.ownedRoot = $ownedRoot

try {
  # Owned fresh GUID directory under RUNNER_TEMP; reject anything pre-existing.
  foreach ($p in @($ownedRoot, $installDir)) {
    if (Test-Path -LiteralPath $p) { throw "owned target already exists, refusing: $p" }
  }
  if (-not (Test-Contained $ownedRoot $runnerTemp)) { throw 'owned root containment check failed' }
  New-Item -ItemType Directory -Path $installDir, $emptyCwd | Out-Null

  # --- Silent install of the exact NSIS candidate into the owned directory. ---
  # Tauri NSIS (currentUser default): silent flag is uppercase /S; /D= sets the
  # install dir and must be the last parameter. Per NSIS docs it takes the rest
  # of the command line unquoted, so the owned GUID path must contain no spaces
  # (guaranteed: RUNNER_TEMP + GUID + 'app').
  if ($installDir -match '\s') { throw "owned install dir contains spaces, /D= cannot be quoted: $installDir" }
  $installerSha = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
  $result.installer['sha256'] = $installerSha

  $installProc = Start-Process -FilePath $installerPath -ArgumentList '/S', "/D=$installDir" `
    -WorkingDirectory $emptyCwd -WindowStyle Hidden -PassThru
  try {
    if (-not $installProc.WaitForExit($InstallTimeoutSec * 1000)) { throw 'installer exceeded deadline' }
  }
  finally {
    if (-not $installProc.HasExited) {
      $installProc.Refresh()
      $cur = Get-Process -Id $installProc.Id -ErrorAction SilentlyContinue
      if ($cur -and ($cur.Path -ne $installerPath -or $cur.StartTime -ne $installProc.StartTime)) {
        throw 'installer process identity changed; refusing to terminate'
      }
      $installProc.Kill()
      $null = $installProc.WaitForExit(10000)
    }
  }
  $installProc.Refresh()
  if ($installProc.ExitCode -ne 0) { throw "silent install failed with exit $($installProc.ExitCode)" }

  # --- Record installed app/runtime paths and hashes. ---
  # MAINBINARYNAME is cho-desktop; WriteUninstaller writes $INSTDIR\uninstall.exe.
  $appExe = Join-Path $installDir 'cho-desktop.exe'
  $runtimeNode = Join-Path $installDir 'runtime/node.exe'
  $runtimeHost = Join-Path $installDir 'runtime/app/apps/desktop/server/host.mjs'
  $uninstallExe = Join-Path $installDir 'uninstall.exe'
  foreach ($f in @($appExe, $runtimeNode, $runtimeHost, $uninstallExe)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "expected installed file missing: $f" }
  }
  $result.installDir = $installDir
  $result.appExe = [ordered]@{ path = $appExe; sha256 = (Get-FileHash -LiteralPath $appExe -Algorithm SHA256).Hash }
  $result.runtimeNode = [ordered]@{ path = $runtimeNode; sha256 = (Get-FileHash -LiteralPath $runtimeNode -Algorithm SHA256).Hash }
  $result['runtimeHost'] = [ordered]@{ path = $runtimeHost; sha256 = (Get-FileHash -LiteralPath $runtimeHost -Algorithm SHA256).Hash }

  # --- Launch installed app from an unrelated empty CWD with a sanitized child env. ---
  # Production native host strips NODE_OPTIONS/NODE_PATH; the child must too, and
  # must not see developer Node/Rust on PATH. Parent/global env is untouched:
  # values are swapped in this process only and restored in finally.
  $savedPath = $env:PATH
  $hadNodeOptions = Test-Path Env:NODE_OPTIONS
  $hadNodePath = Test-Path Env:NODE_PATH
  $savedNodeOptions = $env:NODE_OPTIONS
  $savedNodePath = $env:NODE_PATH
  $childPath = "$env:SystemRoot\System32$([IO.Path]::PathSeparator)$env:SystemRoot"
  $env:PATH = $childPath
  $env:NODE_OPTIONS = '--require C:/cho-deliberately-missing/injected.cjs'
  $env:NODE_PATH = 'C:/cho-deliberately-missing/modules'
  $nodeOnPath = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
  $sanitizedPath = $env:PATH
  $appProc = $null
  try {
    $appProc = Start-Process -FilePath $appExe -ArgumentList '--native-host-smoke' `
      -WorkingDirectory $emptyCwd -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    # Identify the owned handle/path/birth BEFORE any timeout termination.
    $appProc.Refresh()
    $ownedBirth = $appProc.StartTime
    $ownedPath = $appExe
    try {
      if (-not $appProc.WaitForExit($SmokeTimeoutSec * 1000)) { throw 'installed app exceeded smoke deadline' }
    }
    finally {
      if (-not $appProc.HasExited) {
        $appProc.Refresh()
        $cur = Get-Process -Id $appProc.Id -ErrorAction SilentlyContinue
        if (-not $cur) { throw 'owned app handle lost track of its process; refusing PID-only action' }
        if ($cur.Path -ne $ownedPath -or $cur.StartTime -ne $ownedBirth) {
          throw 'owned app identity changed (path/birth mismatch); refusing to terminate'
        }
        $appProc.Kill()
        $null = $appProc.WaitForExit(10000)
      }
    }
    $appProc.Refresh()
    $result.appExit = $appProc.ExitCode
  }
  finally {
    $env:PATH = $savedPath
    if ($hadNodeOptions) { $env:NODE_OPTIONS = $savedNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
    if ($hadNodePath) { $env:NODE_PATH = $savedNodePath } else { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
  }
  $result['childEnvironment'] = [ordered]@{
    childPath = $sanitizedPath; nodeOnPath = $nodeOnPath; poisonedNodeEnvironment = $true
  }

  # --- Parse the real CHO_HOST_SMOKE receipt; require app exit 0 + receipt.ok. ---
  if (-not (Test-Path -LiteralPath $stdoutLog)) { throw 'app produced no stdout log' }
  $lines = @(Get-Content -LiteralPath $stdoutLog | Where-Object { $_.StartsWith('CHO_HOST_SMOKE ') })
  if ($lines.Count -ne 1) { throw "expected exactly one CHO_HOST_SMOKE receipt, found $($lines.Count)" }
  $receipt = $lines[0].Substring(15) | ConvertFrom-Json
  $result.receipt = $receipt
  if ($result.appExit -ne 0) { throw "installed app exit code $($result.appExit), expected 0" }
  if (-not $receipt.ok) { throw "smoke receipt ok=false: $($lines[0])" }
  if ($null -eq $receipt.pid) { throw 'smoke receipt has no host pid' }

  # --- Require the owned host gone. Never PID-kill: without our own handle we
  # --- cannot prove identity across the wait, so a lingering host fails closed. ---
  $hostProc = Get-Process -Id ([int]$receipt.pid) -ErrorAction SilentlyContinue
  if ($hostProc) {
    $null = $hostProc.Handle
    if ($hostProc.Path -ne $runtimeNode) { throw 'host PID identity changed (path is not the installed bundled Node); leaving it alone' }
    if (-not $hostProc.WaitForExit(10000)) { throw 'owned host remained alive after app exit; leaving it alone rather than PID-killing' }
  }
  $result.hostGone = $true

  # --- Silent uninstall of ONLY the owned install; verify the app is absent. ---
  # No removal of user app data and no registry edits by this script; the owned
  # uninstaller handles its own scope on the disposable CI runner.
  # The NSIS uninstaller self-copies to temp by default, so waiting on the
  # original handle can race actual uninstall. `_?=<install-dir>` runs it in
  # place instead (the supported NSIS mechanism; the generated installer.nsi
  # itself appends `_?=$INSTDIR` and notes the in-place uninstaller cannot
  # delete itself), which makes WaitForExit authoritative completion. The app
  # is verified absent only after that wait succeeds. The owned install dir
  # has no spaces (enforced above), so the unquoted rest-of-line `_?=` is safe.
  $result.uninstall.attempted = $true
  if (-not (Test-Contained $uninstallExe $ownedRoot)) { throw 'uninstaller containment check failed' }
  $unProc = Start-Process -FilePath $uninstallExe -ArgumentList '/S', "_?=$installDir" `
    -WorkingDirectory $emptyCwd -WindowStyle Hidden -PassThru
  try {
    if (-not $unProc.WaitForExit($UninstallTimeoutSec * 1000)) { throw 'uninstaller exceeded deadline' }
  }
  finally {
    if (-not $unProc.HasExited) {
      $unProc.Refresh()
      $cur = Get-Process -Id $unProc.Id -ErrorAction SilentlyContinue
      if ($cur -and ($cur.Path -ne $uninstallExe -or $cur.StartTime -ne $unProc.StartTime)) {
        throw 'uninstaller process identity changed; refusing to terminate'
      }
      $unProc.Kill()
      $null = $unProc.WaitForExit(10000)
    }
  }
  if (Test-Path -LiteralPath $appExe) { throw 'owned app still present after silent uninstall' }
  $result.uninstall.appAbsent = $true

  # --- Recursive cleanup only inside the verified owned root. ---
  if (-not (Test-Contained $installDir $ownedRoot)) { throw 'install dir containment check failed' }
  Remove-Item -LiteralPath $ownedRoot -Recurse -Force
  $result.cleanup.ownedRootRemoved = (-not (Test-Path -LiteralPath $ownedRoot))
  if (-not $result.cleanup.ownedRootRemoved) { throw 'owned root could not be fully removed' }

  $result.verdict = 'PASS'
  Write-Result
  Write-Output "$Label passed; installer=$installerSha"
  exit 0
}
catch {
  $result.error = $_.Exception.Message
  Write-Result
  Fail $_.Exception.Message
}
