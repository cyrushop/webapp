import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Apps launched from Finder get a minimal PATH, so look for tools in the usual install places.
const HOME = os.homedir();

/** Writable per-user folder (the .app bundle itself may be read-only / translocated). */
export function dataDir() {
  const dir =
    process.env.GPS_SIM_DATA ||
    (process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'PikminGPS')
      : path.join(HOME, '.pikmin-gps'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (d && isExec(path.join(d, name))) return path.join(d, name);
  }
  return null;
}

export function findAdb() {
  if (process.env.ADB_PATH) return process.env.ADB_PATH;
  const candidates = [
    path.join(HOME, 'Library/Android/sdk/platform-tools/adb'), // Android Studio (macOS)
    path.join(HOME, 'Android/Sdk/platform-tools/adb'), // Android Studio (Linux)
    path.join(HOME, 'platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ];
  return candidates.find(isExec) || onPath('adb') || 'adb';
}

function pythonVersion(p) {
  try {
    const out = execFileSync(p, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [maj, min] = String(out).trim().split('.').map(Number);
    return { maj, min };
  } catch {
    return null;
  }
}

/** A Python ≥ 3.10 to build the iPhone venv with (Homebrew / python.org first). */
export function findPython() {
  const names = ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin'];
  const seen = new Set();
  const list = [];
  for (const n of names) {
    for (const d of dirs) list.push(path.join(d, n));
    const p = onPath(n);
    if (p) list.push(p);
  }
  list.push('/usr/bin/python3');
  for (const p of list) {
    if (seen.has(p) || !isExec(p)) continue;
    seen.add(p);
    const v = pythonVersion(p);
    if (v && (v.maj > 3 || (v.maj === 3 && v.min >= 10))) return { path: p, version: `${v.maj}.${v.min}` };
  }
  return null;
}

export function iosVenvPython() {
  return path.join(dataDir(), 'ios-venv', 'bin', 'python');
}

/** Picks the Python that runs ios_bridge.py: explicit env, app data venv, repo venv, system. */
export function resolveIosPython(repoVenv) {
  if (process.env.IOS_PYTHON) return process.env.IOS_PYTHON;
  const appVenv = iosVenvPython();
  if (isExec(appVenv)) return appVenv;
  if (repoVenv && isExec(repoVenv)) return repoVenv;
  return 'python3';
}

function run(cmd, args, onLine) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (d) =>
      String(d)
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .forEach((l) => onLine(l.slice(0, 300)));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => {
      onLine(`錯誤：${e.message}`);
      resolve(false);
    });
    p.on('exit', (code) => resolve(code === 0));
  });
}

let setupRunning = false;

/** Creates <dataDir>/ios-venv and installs/updates pymobiledevice3. Streams progress via onLine. */
export async function setupIos(onLine) {
  if (setupRunning) return { ok: false, error: '安裝已在進行中' };
  setupRunning = true;
  try {
    const py = findPython();
    if (!py) {
      onLine('找不到 Python 3.10 或以上。請先安裝：brew install python@3.13 或 https://www.python.org/downloads/macos/');
      return { ok: false, error: 'no python' };
    }
    onLine(`使用 Python ${py.version}：${py.path}`);
    const venv = path.join(dataDir(), 'ios-venv');
    const vpy = path.join(venv, 'bin', 'python');
    if (!isExec(vpy)) {
      onLine(`建立 Python 環境：${venv}`);
      if (!(await run(py.path, ['-m', 'venv', venv], onLine))) return { ok: false, error: 'venv failed' };
    }
    onLine('安裝 / 更新 pymobiledevice3（約 1–3 分鐘）…');
    await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], () => {});
    const ok = await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pymobiledevice3'], (l) => {
      if (/^(Successfully|ERROR|error|Collecting pymobiledevice3|Requirement already satisfied: pymobiledevice3)/.test(l)) onLine(l);
    });
    if (!ok) return { ok: false, error: 'pip failed' };
    onLine('嘗試令 iPhone 顯示「開發者模式」選項（iPhone 需已連接、解鎖並信任此電腦）…');
    await run(vpy, ['-m', 'pymobiledevice3', 'amfi', 'reveal-developer-mode'], () => {});
    onLine('✅ iPhone 支援已安裝');
    return { ok: true, python: vpy };
  } finally {
    setupRunning = false;
  }
}
