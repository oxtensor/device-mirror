$ErrorActionPreference = 'Stop'
$msbuild = 'C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\amd64\MSBuild.exe'
if (-not (Test-Path $msbuild)) {
  $msbuild = 'C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe'
}
$sln = Join-Path $PSScriptRoot '..\vendor\vcam\cpp\VCam\VCam.sln'
& $msbuild $sln /p:Configuration=Release /p:Platform=x64 /m /nologo /v:m
$out = Join-Path $PSScriptRoot '..\vendor\vcam\cpp\VCam\x64\Release'
$runtime = Join-Path $PSScriptRoot '..\vendor\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item (Join-Path $out 'VCamSource.dll') $runtime -Force
Copy-Item (Join-Path $out 'VCamRegistrar.exe') $runtime -Force
Write-Host "Copied runtime to $runtime"
