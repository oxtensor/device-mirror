/**
 * Install / register Device Mirror's embedded virtual camera + microphone.
 * No OBS / VB-Cable required.
 *
 * Camera COM (VCamSource.dll) MUST be registered under HKLM so Frame Server
 * can load it. That needs one UAC prompt. After that VCamRegistrar.exe
 * (unelevated) starts the session camera.
 */
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME_SRC = path.join(ROOT, 'vendor', 'runtime');
const AUDIO_INF_SRC = path.join(
  ROOT,
  'vendor',
  'audio-driver',
  'Virtual Audio Driver',
  'VirtualAudioDriver.inf'
);
const INSTALL_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'DeviceMirror');
const VCAM_DLL = path.join(INSTALL_DIR, 'VCamSource.dll');
const VCAM_REG = path.join(INSTALL_DIR, 'VCamRegistrar.exe');
const PUMP_EXE = path.join(ROOT, 'dm-vdevices', 'target', 'release', 'dm-vdevices.exe');
const PUMP_RUNTIME = path.join(RUNTIME_SRC, 'dm-vdevices.exe');
const PUMP_INSTALLED = path.join(INSTALL_DIR, 'dm-vdevices.exe');
const CLSID = '{3cad447d-f283-4af4-a3b2-6f5363309f52}';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function ensureInstallDir() {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function newestExisting(...candidates) {
  return candidates
    .filter((p) => p && fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function copyRuntime() {
  ensureInstallDir();
  const releaseDir = path.join(ROOT, 'vendor', 'vcam', 'cpp', 'VCam', 'x64', 'Release');
  const dllSrc = newestExisting(
    path.join(releaseDir, 'VCamSource.dll'),
    path.join(RUNTIME_SRC, 'VCamSource.dll')
  );
  const regSrc = newestExisting(
    path.join(releaseDir, 'VCamRegistrar.exe'),
    path.join(RUNTIME_SRC, 'VCamRegistrar.new.exe'),
    path.join(RUNTIME_SRC, 'VCamRegistrar.exe')
  );
  if (dllSrc) {
    try {
      fs.copyFileSync(dllSrc, VCAM_DLL);
    } catch (_) {}
  }
  if (regSrc) {
    try {
      fs.copyFileSync(regSrc, VCAM_REG);
    } catch (_) {
      // Old registrar may still be running; use source path instead.
    }
  }
  const pumpSrc = newestExisting(PUMP_EXE, PUMP_RUNTIME, PUMP_INSTALLED);
  if (pumpSrc && pumpSrc !== PUMP_INSTALLED) {
    try {
      fs.copyFileSync(pumpSrc, PUMP_INSTALLED);
    } catch (_) {}
  }
  const audioSrcDir = path.dirname(AUDIO_INF_SRC);
  const audioDst = path.join(INSTALL_DIR, 'audio-driver');
  if (fs.existsSync(audioSrcDir)) {
    fs.mkdirSync(audioDst, { recursive: true });
    for (const f of fs.readdirSync(audioSrcDir)) {
      try {
        fs.copyFileSync(path.join(audioSrcDir, f), path.join(audioDst, f));
      } catch (_) {}
    }
  }
}

async function isCameraRegistered() {
  const r = await run('reg', [
    'query',
    `HKLM\\SOFTWARE\\Classes\\CLSID\\${CLSID}\\InprocServer32`,
  ]);
  if (!r.ok) return false;
  const m = r.stdout.match(/REG_SZ\s+(.+)/);
  if (!m) return true;
  const dll = m[1].trim();
  return dll && fs.existsSync(dll);
}

function registrarExe() {
  return newestExisting(
    path.join(ROOT, 'vendor', 'vcam', 'cpp', 'VCam', 'x64', 'Release', 'VCamRegistrar.exe'),
    path.join(RUNTIME_SRC, 'VCamRegistrar.new.exe'),
    VCAM_REG,
    path.join(RUNTIME_SRC, 'VCamRegistrar.exe')
  );
}

async function registerCamera() {
  copyRuntime();
  const exe = registrarExe();
  if (!exe || !fs.existsSync(VCAM_DLL) && !newestExisting(path.join(ROOT, 'vendor', 'vcam', 'cpp', 'VCam', 'x64', 'Release', 'VCamSource.dll'))) {
    return { ok: false, error: 'VCam binaries missing — run npm run build:vcam' };
  }

  // New registrar copies DLL to ProgramData and self-elevates /register-only (UAC once).
  const r = await run(exe, ['/register-only']);
  if (await isCameraRegistered()) return { ok: true };

  await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '/register-only' -Verb RunAs -Wait`,
  ]);
  if (await isCameraRegistered()) return { ok: true };
  return {
    ok: false,
    error: 'Need admin once to register Device Mirror Camera (COM class 80040154)',
  };
}

function isRegistrarRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq VCamRegistrar.exe'],
      { windowsHide: true },
      (_e, stdout) => {
        resolve(String(stdout).toLowerCase().includes('vcamregistrar.exe'));
      }
    );
  });
}

async function stopBrokenRegistrar() {
  await run('taskkill', ['/F', '/IM', 'VCamRegistrar.exe']);
}

async function startRegistrar() {
  if (await isRegistrarRunning()) return { ok: true, already: true };
  const exe = registrarExe();
  if (!exe) return { ok: false, error: 'VCamRegistrar.exe missing' };
  spawn(exe, ['/headless'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(exe),
  }).unref();
  return { ok: true };
}

async function isAudioInstalled() {
  const r = await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Get-PnpDevice -Class Media -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Virtual (Audio|Mic)' } | Select-Object -First 1 -ExpandProperty Status",
  ]);
  return r.ok && /ok|unknown/i.test(r.stdout);
}

async function installAudioDriver() {
  copyRuntime();
  if (await isAudioInstalled()) return { ok: true };
  const script = path.join(ROOT, 'scripts', 'install-virtual-audio.ps1');
  if (!fs.existsSync(script)) {
    return { ok: false, error: 'install-virtual-audio.ps1 missing' };
  }
  const elevated = await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}' -Verb RunAs -Wait`,
  ]);
  if (await isAudioInstalled()) return { ok: true };
  return {
    ok: false,
    error: elevated.ok
      ? 'Virtual mic driver did not appear after install'
      : 'Need admin once to install Virtual Mic Driver by MTT',
  };
}

let pumpProc = null;

function startPump() {
  if (pumpProc && !pumpProc.killed) return { ok: true, already: true };
  const exe = fs.existsSync(PUMP_INSTALLED)
    ? PUMP_INSTALLED
    : fs.existsSync(PUMP_EXE)
      ? PUMP_EXE
      : fs.existsSync(PUMP_RUNTIME)
        ? PUMP_RUNTIME
        : null;
  if (!exe) {
    return { ok: false, error: 'dm-vdevices.exe missing — run npm run build:vdevices' };
  }
  pumpProc = spawn(exe, [], {
    stdio: 'ignore',
    windowsHide: true,
    cwd: INSTALL_DIR,
  });
  pumpProc.on('exit', () => {
    pumpProc = null;
  });
  return { ok: true };
}

function stopPump() {
  if (pumpProc && !pumpProc.killed) {
    try {
      pumpProc.kill();
    } catch (_) {}
  }
  pumpProc = null;
}

async function ensureVirtualDevices() {
  copyRuntime();
  const cameraReg = (await isCameraRegistered())
    ? { ok: true, already: true }
    : await registerCamera();

  if (cameraReg.ok) {
    // Restart registrar so it binds the newly registered COM class.
    if (await isRegistrarRunning()) await stopBrokenRegistrar();
    await startRegistrar();
  }

  const audio = (await isAudioInstalled()) ? { ok: true, already: true } : await installAudioDriver();
  const pump = startPump();
  return {
    ok: cameraReg.ok && pump.ok,
    camera: cameraReg,
    registrar: { ok: cameraReg.ok },
    audio,
    pump,
    cameraName: 'Device Mirror Camera',
    micName: 'Virtual Mic Driver by MTT',
    speakerName: 'Virtual Audio Driver by MTT',
    hint:
      'Select “Device Mirror Camera” and “Virtual Mic Driver by MTT” in apps. ' +
      (cameraReg.ok
        ? ''
        : 'Approve the one-time admin prompt so the camera COM class can be registered.'),
  };
}

module.exports = {
  ensureVirtualDevices,
  startPump,
  stopPump,
  INSTALL_DIR,
};
