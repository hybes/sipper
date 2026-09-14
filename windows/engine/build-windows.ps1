# Builds sipper-engine.exe and sipper-browser-host.exe with MSVC against the PJSIP and Opus build
# from windows/scripts/build-pjsip.ps1. Writes windows/engine/build/.
#
#   pwsh windows/engine/build-windows.ps1
param(
  [string]$Deps = (Join-Path $PSScriptRoot '..\vendor\pjsip-win')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Enter-DeveloperShell {
  if (Get-Command cl.exe -ErrorAction SilentlyContinue) { return }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { throw 'Visual Studio with the C++ tools is not installed.' }
  Import-Module (Join-Path $vs 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
  Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

$Deps = (Resolve-Path $Deps).Path
$library = Join-Path $Deps 'lib\libpjproject-x86_64-x64-vc14-Release-Static.lib'
if (-not (Test-Path $library)) { throw "PJSIP is not built: $library is missing (run windows/scripts/build-pjsip.ps1)." }

Enter-DeveloperShell

$out = Join-Path $PSScriptRoot 'build'
$objects = Join-Path $out 'obj'
New-Item -ItemType Directory -Force -Path $objects | Out-Null

$version = (Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
Set-Content -Path (Join-Path $out 'sipper_version.h') -Encoding ascii -Value "#define SIPPER_VERSION `"$version`""

$cjson = Join-Path $PSScriptRoot 'third_party\cjson'
$manifest = Join-Path $PSScriptRoot 'sipper.manifest'
$compile = @(
  '/nologo', '/O2', '/MT', '/W3', '/utf-8', '/GS', '/guard:cf',
  '/DWIN64', '/DPJ_WIN64=1', '/DPJ_M_X86_64=1', '/D_CRT_SECURE_NO_WARNINGS',
  "/I$(Join-Path $Deps 'include')", "/I$cjson", "/I$out", "/Fo$objects\"
)
$link = @('/link', '/SUBSYSTEM:CONSOLE', '/DYNAMICBASE', '/NXCOMPAT', '/guard:cf', '/MANIFEST:EMBED', "/MANIFESTINPUT:$manifest")
$systemLibraries = @(
  'ws2_32.lib', 'mswsock.lib', 'iphlpapi.lib', 'winmm.lib', 'ole32.lib', 'oleaut32.lib', 'uuid.lib',
  'advapi32.lib', 'user32.lib', 'gdi32.lib', 'secur32.lib', 'crypt32.lib', 'bcrypt.lib', 'shlwapi.lib'
)

Write-Host '==> sipper-engine.exe'
Invoke-Checked 'cl.exe' ($compile + @(
  (Join-Path $PSScriptRoot 'src\engine.c'), (Join-Path $cjson 'cJSON.c'), "/Fe$(Join-Path $out 'sipper-engine.exe')"
) + $link + @("/LIBPATH:$(Join-Path $Deps 'lib')", (Split-Path $library -Leaf), 'opus.lib') + $systemLibraries)

Write-Host '==> sipper-browser-host.exe'
Invoke-Checked 'cl.exe' ($compile + @(
  (Join-Path $PSScriptRoot 'src\native_host.c'), (Join-Path $cjson 'cJSON.c'), "/Fe$(Join-Path $out 'sipper-browser-host.exe')"
) + $link + @('shell32.lib'))

& (Join-Path $out 'sipper-engine.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'sipper-engine.exe does not run.' }
Write-Host "Built $out"
