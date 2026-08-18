# Register Device Mirror Camera (VCamSource.dll) and copy runtime to ProgramData.
# Run once as Administrator, or let VCamRegistrar.exe prompt for UAC.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'vendor\runtime'
$Dest = Join-Path $env:ProgramData 'DeviceMirror'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

foreach ($name in @('VCamSource.dll', 'VCamRegistrar.exe', 'dm-vdevices.exe')) {
  $src = Join-Path $Runtime $name
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $Dest $name) -Force
  }
}

icacls $Dest /grant '*S-1-1-0:(OI)(CI)RX' /T /C | Out-Null

$dll = Join-Path $Dest 'VCamSource.dll'
if (-not (Test-Path $dll)) { throw "VCamSource.dll missing. Run npm run build:vcam first." }

& regsvr32.exe /s $dll
if ($LASTEXITCODE -ne 0) { throw "regsvr32 failed with $LASTEXITCODE — run this script as Administrator" }

reg query 'HKLM\SOFTWARE\Classes\CLSID\{3cad447d-f283-4af4-a3b2-6f5363309f52}\InprocServer32'
if ($LASTEXITCODE -ne 0) { throw 'COM class still not registered' }

Write-Host "Registered Device Mirror Camera from $dll"
Write-Host "You can now start: $Dest\VCamRegistrar.exe /headless"
