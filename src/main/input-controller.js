/**
 * Scale remote video coordinates to the selected display's screen coordinates.
 */
const { screen } = require('electron');
const { execFile } = require('child_process');
const { ControlMessageType } = require('../../shared/protocol');

function ps(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 2000 },
      () => resolve()
    );
  });
}

function createInputController() {
  let lastMove = 0;
  let displayBounds = null;

  function setDisplayBounds(bounds) {
    displayBounds = bounds;
  }

  function mapPoint(msg) {
    const primary = screen.getPrimaryDisplay();
    const bounds = displayBounds || primary.bounds;
    const frameW = msg.frameWidth || bounds.width;
    const frameH = msg.frameHeight || bounds.height;
    const x = bounds.x + ((msg.x || 0) / frameW) * bounds.width;
    const y = bounds.y + ((msg.y || 0) / frameH) * bounds.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function handle(msg = {}) {
    const type = msg.type;
    switch (type) {
      case ControlMessageType.MOUSE_MOVE: {
        const now = Date.now();
        if (now - lastMove < 8) return;
        lastMove = now;
        const { x, y } = mapPoint(msg);
        ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`);
        break;
      }
      case ControlMessageType.MOUSE_DOWN:
      case ControlMessageType.MOUSE_UP: {
        const down = type === ControlMessageType.MOUSE_DOWN;
        const button = msg.button || 'left';
        const code =
          button === 'right' ? (down ? 0x0008 : 0x0010) : down ? 0x0002 : 0x0004;
        ps(`Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);'; [W.U]::mouse_event(${code},0,0,0,0)`);
        break;
      }
      case ControlMessageType.MOUSE_WHEEL: {
        const delta = Math.round(msg.deltaY || 0);
        ps(`Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);'; [W.U]::mouse_event(0x0800,0,0,${delta},0)`);
        break;
      }
      case ControlMessageType.KEY_DOWN:
      case ControlMessageType.KEY_UP: {
        const key = sanitizeKey(msg.key);
        if (!key) return;
        const down = type === ControlMessageType.KEY_DOWN;
        const vk = keyVk(key);
        if (vk == null) return;
        const flags = down ? 0 : 2;
        ps(`Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,uint dwExtraInfo);'; [W.U]::keybd_event(${vk},0,${flags},0)`);
        break;
      }
      case 'set-display-bounds':
        setDisplayBounds(msg.bounds);
        break;
      default:
        break;
    }
  }

  return { handle, setDisplayBounds };
}

function sanitizeKey(key) {
  if (!key || typeof key !== 'string') return null;
  return key.slice(0, 32);
}

function keyVk(key) {
  const map = {
    Backspace: 0x08,
    Tab: 0x09,
    Enter: 0x0d,
    Shift: 0x10,
    Control: 0x11,
    Alt: 0x12,
    Escape: 0x1b,
    ' ': 0x20,
    Space: 0x20,
    PageUp: 0x21,
    PageDown: 0x22,
    End: 0x23,
    Home: 0x24,
    ArrowLeft: 0x25,
    ArrowUp: 0x26,
    ArrowRight: 0x27,
    ArrowDown: 0x28,
    Delete: 0x2e,
    Meta: 0x5b,
  };
  if (map[key] != null) return map[key];
  if (key.length === 1) {
    const c = key.toUpperCase();
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return code;
    if (code >= 48 && code <= 57) return code;
  }
  if (/^F([1-9]|1[0-2])$/.test(key)) {
    return 0x70 + (parseInt(key.slice(1), 10) - 1);
  }
  return null;
}

module.exports = { createInputController };
