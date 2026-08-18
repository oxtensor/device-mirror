# Install the bundled Virtual Audio Driver (speaker + Virtual Mic Driver by MTT).
# Requires Administrator. pnputil only publishes the INF; ROOT\VirtualAudioDriver
# must also be created or Sound settings never show the devices.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Inf = Join-Path $Root 'vendor\audio-driver\Virtual Audio Driver\VirtualAudioDriver.inf'
$HardwareId = 'ROOT\VirtualAudioDriver'
$ClassGuid = [guid]'{4d36e96c-e325-11ce-bfc1-08002be10318}'

if (-not (Test-Path $Inf)) { throw "Missing INF: $Inf" }

Write-Host 'Adding driver package...'
& pnputil /add-driver $Inf /install
if ($LASTEXITCODE -notin 0, 259, 3010) {
  Write-Warning "pnputil returned $LASTEXITCODE (continuing to create device node)"
}

$existing = Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like 'ROOT\VIRTUALAUDIODRIVER*' }
if ($existing) {
  Write-Host "Device already present: $($existing.InstanceId) ($($existing.Status))"
  & pnputil /add-driver $Inf /install | Out-Host
  exit 0
}

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RootPnp {
  public const int DICD_GENERATE_ID = 0x00000001;
  public const uint SPDRP_HARDWAREID = 0x00000001;
  public const uint DIF_REGISTERDEVICE = 0x00000019;
  public const uint INSTALLFLAG_FORCE = 0x00000001;

  [StructLayout(LayoutKind.Sequential)]
  public struct SP_DEVINFO_DATA {
    public uint cbSize;
    public Guid ClassGuid;
    public uint DevInst;
    public IntPtr Reserved;
  }

  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid ClassGuid, IntPtr hwndParent);

  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetupDiCreateDeviceInfo(
    IntPtr DeviceInfoSet, string DeviceName, ref Guid ClassGuid,
    string DeviceDescription, IntPtr hwndParent, int CreationFlags,
    ref SP_DEVINFO_DATA DeviceInfoData);

  [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetupDiSetDeviceRegistryProperty(
    IntPtr DeviceInfoSet, ref SP_DEVINFO_DATA DeviceInfoData,
    uint Property, byte[] PropertyBuffer, uint PropertyBufferSize);

  [DllImport("setupapi.dll", SetLastError = true)]
  public static extern bool SetupDiCallClassInstaller(
    uint InstallFunction, IntPtr DeviceInfoSet, ref SP_DEVINFO_DATA DeviceInfoData);

  [DllImport("setupapi.dll", SetLastError = true)]
  public static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

  [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool UpdateDriverForPlugAndPlayDevices(
    IntPtr hwndParent, string HardwareId, string FullInfPath,
    uint InstallFlags, out bool bRebootRequired);

  public static int CreateAndInstall(string hardwareId, Guid classGuid, string infPath) {
    IntPtr set = SetupDiCreateDeviceInfoList(ref classGuid, IntPtr.Zero);
    if (set == IntPtr.Zero || set == new IntPtr(-1)) return Marshal.GetLastWin32Error();

    SP_DEVINFO_DATA data = new SP_DEVINFO_DATA();
    data.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));

    if (!SetupDiCreateDeviceInfo(set, "VirtualAudioDriver", ref classGuid, null, IntPtr.Zero, DICD_GENERATE_ID, ref data)) {
      int err = Marshal.GetLastWin32Error();
      SetupDiDestroyDeviceInfoList(set);
      return err;
    }

    byte[] hwid = Encoding.Unicode.GetBytes(hardwareId + "\0\0");
    if (!SetupDiSetDeviceRegistryProperty(set, ref data, SPDRP_HARDWAREID, hwid, (uint)hwid.Length)) {
      int err = Marshal.GetLastWin32Error();
      SetupDiDestroyDeviceInfoList(set);
      return err;
    }

    if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref data)) {
      int err = Marshal.GetLastWin32Error();
      SetupDiDestroyDeviceInfoList(set);
      return err;
    }

    SetupDiDestroyDeviceInfoList(set);

    bool reboot;
    if (!UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, hardwareId, infPath, INSTALLFLAG_FORCE, out reboot)) {
      return Marshal.GetLastWin32Error();
    }
    return 0;
  }
}
'@

Add-Type -TypeDefinition $code
Write-Host "Creating $HardwareId ..."
$err = [RootPnp]::CreateAndInstall($HardwareId, $ClassGuid, $Inf)
if ($err -ne 0) { throw "CreateAndInstall failed with Win32 error $err" }

Start-Sleep -Seconds 2
Get-PnpDevice -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like 'ROOT\VIRTUALAUDIODRIVER*' -or $_.FriendlyName -match 'Virtual (Audio|Mic) Driver' } |
  Format-Table Status, Class, FriendlyName, InstanceId -AutoSize

Write-Host 'Done. Sound settings should list Virtual Audio Driver by MTT and Virtual Mic Driver by MTT.'
