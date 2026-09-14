# Builds PJSIP (pjproject) and Opus for 64-bit Windows with MSVC and installs what the engine needs
# into windows/vendor/pjsip-win: headers in include\, the merged pjproject library and Opus in lib\,
# and licence texts in licences\. Mirrors scripts/build-pjsip.sh, the macOS build: video, iLBC,
# G.722.1 and SILK off; Opus and the WebRTC echo canceller on; TLS through Windows Schannel; WMME
# audio. Needs Visual Studio 2022 with the C++ tools, CMake and tar (all on GitHub's Windows images).
#
#   pwsh windows/scripts/build-pjsip.ps1
param(
  [string]$PjsipVersion = '2.15.1',
  [string]$PjsipSha256 = '8f3bd99caf003f96ed8038b8a36031eb9d8cd9eaea1eaff7e01c2eef6bd55706',
  [string]$OpusVersion = '1.6.1',
  [string]$OpusSha256 = '6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1',
  # A short folder: the Visual Studio projects nest their intermediate folders deeply.
  [string]$Work = (Join-Path $env:SystemDrive 'sipper-build')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$prefix = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'vendor\pjsip-win'

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

function Get-Verified([string[]]$Urls, [string]$File, [string]$Sha256) {
  foreach ($url in $Urls) {
    if (-not (Test-Path $File)) {
      try {
        Invoke-WebRequest -Uri $url -OutFile $File -UseBasicParsing
      } catch {
        Write-Warning "Download from $url failed: $_"
        continue
      }
    }
    $actual = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLowerInvariant()
    if ($actual -eq $Sha256) { return }
    Write-Warning "Checksum mismatch for the copy from $url ($actual)"
    Remove-Item -Force $File
  }
  throw "No verified copy of $(Split-Path $File -Leaf); set the checksum parameter when changing versions."
}

New-Item -ItemType Directory -Force -Path $Work | Out-Null
Enter-DeveloperShell

$pj = Join-Path $Work "pjproject-$PjsipVersion"
if (-not (Test-Path $pj)) {
  $tarball = Join-Path $Work "pjproject-$PjsipVersion.tar.gz"
  Get-Verified @("https://github.com/pjsip/pjproject/archive/refs/tags/$PjsipVersion.tar.gz") $tarball $PjsipSha256
  Invoke-Checked 'tar' @('-xzf', $tarball, '-C', $Work)
}

$opusSource = Join-Path $Work "opus-$OpusVersion"
$opus = Join-Path $Work 'opus'
if (-not (Test-Path $opusSource)) {
  $tarball = Join-Path $Work "opus-$OpusVersion.tar.gz"
  Get-Verified @(
    "https://ftp.osuosl.org/pub/xiph/releases/opus/opus-$OpusVersion.tar.gz",
    "https://downloads.xiph.org/releases/opus/opus-$OpusVersion.tar.gz"
  ) $tarball $OpusSha256
  Invoke-Checked 'tar' @('-xzf', $tarball, '-C', $Work)
}

Write-Host "==> Opus $OpusVersion"
# OPUS_STATIC_RUNTIME selects /MT to match PJSIP's Release-Static build. Opus's CMakeLists sets
# CMAKE_MSVC_RUNTIME_LIBRARY itself, so passing that variable would be ignored.
$opusBuild = Join-Path $Work 'opus-build'
Invoke-Checked 'cmake' @('-S', $opusSource, '-B', $opusBuild, '-A', 'x64',
  '-DOPUS_BUILD_SHARED_LIBRARY=OFF', '-DOPUS_STATIC_RUNTIME=ON', '-DOPUS_BUILD_TESTING=OFF',
  '-DOPUS_BUILD_PROGRAMS=OFF', "-DCMAKE_INSTALL_PREFIX=$opus")
Invoke-Checked 'cmake' @('--build', $opusBuild, '--config', 'Release', '--target', 'install')

Write-Host '==> config_site.h'
$configSite = @'
/* Sipper: PJSIP configuration for the Windows softphone engine (windows/scripts/build-pjsip.ps1). */
#define PJ_HAS_IPV6 1
#define PJ_HAS_SSL_SOCK 1
#define PJ_SSL_SOCK_IMP PJ_SSL_SOCK_IMP_SCHANNEL
#define PJMEDIA_HAS_VIDEO 0
#define PJMEDIA_HAS_ILBC_CODEC 0
#define PJMEDIA_HAS_G7221_CODEC 0
#define PJMEDIA_HAS_SILK_CODEC 0
#define PJMEDIA_HAS_OPUS_CODEC 1
#define PJMEDIA_HAS_WEBRTC_AEC 1
#define PJMEDIA_AUDIO_DEV_HAS_WMME 1
#define PJSUA_MAX_ACC 32
#define PJSUA_MAX_CALLS 32
#define PJSIP_TCP_KEEP_ALIVE_INTERVAL 30
#define PJSIP_TLS_KEEP_ALIVE_INTERVAL 30
'@
Set-Content -Path (Join-Path $pj 'pjlib\include\pj\config_site.h') -Value $configSite -Encoding ascii

Write-Host "==> pjproject $PjsipVersion (Release-Static, x64)"
# Only the merged library project: the solution also holds UWP and C# projects that do not build here.
$env:INCLUDE = "$(Join-Path $opus 'include');$env:INCLUDE"
$env:LIB = "$(Join-Path $opus 'lib');$env:LIB"
Invoke-Checked 'msbuild' @((Join-Path $pj 'pjsip-apps\build\libpjproject.vcxproj'), '/m', '/nologo', '/v:minimal',
  '/p:Configuration=Release-Static', '/p:Platform=x64', '/p:PlatformToolset=v143',
  '/p:WindowsTargetPlatformVersion=10.0', '/p:UseEnv=true')

$merged = Join-Path $pj 'lib\libpjproject-x86_64-x64-vc14-Release-Static.lib'
$members = & lib.exe /nologo /list $merged
foreach ($needed in @('ssl_sock_schannel', 'opus.obj', 'wmme_dev', 'echo_webrtc', 'pjsua_core')) {
  if (-not ($members | Select-String -SimpleMatch $needed)) { throw "$needed is missing from $merged" }
}

Write-Host "==> Installing into $prefix"
if (Test-Path $prefix) { Remove-Item -Recurse -Force $prefix }
foreach ($folder in 'include', 'lib', 'licences') { New-Item -ItemType Directory -Force -Path (Join-Path $prefix $folder) | Out-Null }
foreach ($project in 'pjlib', 'pjlib-util', 'pjnath', 'pjmedia', 'pjsip') {
  Copy-Item -Recurse -Force (Join-Path $pj "$project\include\*") (Join-Path $prefix 'include')
}
Copy-Item $merged (Join-Path $prefix 'lib')
Copy-Item (Join-Path $opus 'lib\opus.lib') (Join-Path $prefix 'lib\opus.lib')
# PJSIP 2.15.1's Opus codec asks the linker for "libopus.a" by name (#pragma comment(lib) in opus.c).
Copy-Item (Join-Path $opus 'lib\opus.lib') (Join-Path $prefix 'lib\libopus.a')

$licences = Join-Path $prefix 'licences'
Copy-Item (Join-Path $pj 'COPYING') (Join-Path $licences 'PJSIP.txt')
Copy-Item (Join-Path $pj 'third_party\srtp\LICENSE') (Join-Path $licences 'libsrtp.txt')
Copy-Item (Join-Path $pj 'third_party\speex\COPYING') (Join-Path $licences 'Speex.txt')
Copy-Item (Join-Path $pj 'third_party\gsm\COPYRIGHT') (Join-Path $licences 'GSM.txt')
Copy-Item (Join-Path $pj 'third_party\resample\COPYING') (Join-Path $licences 'libresample.txt')
$webrtc = (Get-Content -Raw (Join-Path $pj 'third_party\webrtc\LICENSE')) + "`r`n`r`n" + (Get-Content -Raw (Join-Path $pj 'third_party\webrtc\LICENSE_THIRD_PARTY'))
Set-Content -Path (Join-Path $licences 'WebRTC.txt') -Value $webrtc
Copy-Item (Join-Path $opusSource 'COPYING') (Join-Path $licences 'Opus.txt')

Set-Content -Path (Join-Path $prefix 'BUILD-INFO.txt') -Value @"
pjproject $PjsipVersion for x64, MSVC $env:VCToolsVersion, Release-Static (/MT)
opus: $OpusVersion

--- config_site.h ---
$configSite
"@
Write-Host "Done: $prefix"
