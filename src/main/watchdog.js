/**
 * Watchdog: keeps Device Mirror running. Launch with:
 *   npm run watchdog
 * Or register as a startup task alongside the app.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const CHECK_MS = 5000;
let child = null;

function startApp() {
  if (child && !child.killed) return;
  const electronBin = require('electron');
  child = spawn(electronBin, [ROOT], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
    env: process.env,
  });
  child.on('exit', () => {
    child = null;
    console.log('[watchdog] app exited — restarting in 2s');
    setTimeout(startApp, 2000);
  });
  console.log('[watchdog] started app pid', child.pid);
}

console.log('[watchdog] Device Mirror auto-restart active');
startApp();

setInterval(() => {
  if (!child) startApp();
}, CHECK_MS);

process.on('SIGINT', () => {
  if (child) child.kill();
  process.exit(0);
});
