import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AdbDevice, listDevices, listPackages } from '../src/adb.js';
import { findAdb } from '../src/adb-path.js';
import { Board } from '../src/board.js';
import { validateConfig } from '../src/config.js';
import { findEmulator, listAvds, startEmulators } from '../src/emulator.js';
import type { RunControl } from '../src/explorer.js';
import { FakeDevice } from '../src/fake.js';
import { runCrawl } from '../src/run.js';
import type { Device, RunSummary } from '../src/types.js';

interface SavedSettings {
  package?: string;
  devices?: string[];
  maxMinutes?: number;
  blacklist?: string[];
  adbPath?: string;
  emulators?: { autoStart: boolean; avds: Record<string, string> };
}

let mainWin: BrowserWindow | null = null;
let currentBoard: Board | null = null;
let currentCtl: RunControl | null = null;
let currentAbort: AbortController | null = null;
let isRunning = false;
let activeRunPromise: Promise<RunSummary> | null = null;
let lastRunDir: string | null = null;

const isFake = process.env.SIMCRAWLER_FAKE === '1';

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function loadSettings(): SavedSettings {
  try {
    const file = getSettingsPath();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf8'));
    }
  } catch {}
  return {};
}

function saveSettings(s: SavedSettings): void {
  try {
    const file = getSettingsPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}

function verifySender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) {
    throw new Error('Từ chối IPC từ nguồn không xác thực');
  }
}

function createWindow(): void {
  const iconPath = join(__dirname, 'icon.png');
  mainWin = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0e1116',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWin.loadFile(join(__dirname, 'page.html'));

  mainWin.on('closed', () => {
    mainWin = null;
  });
}

// ------------------------------------------------------------ IPC Handlers

ipcMain.handle('app:getInitial', async (event) => {
  verifySender(event);
  const settings = loadSettings();
  const adb = findAdb({ userPath: settings.adbPath });
  return { settings, adb, isFake };
});

ipcMain.handle('adb:listDevices', async (event) => {
  verifySender(event);
  if (isFake) {
    return [
      { serial: 'emulator-5554', state: 'device', model: 'Fake Device 1' },
      { serial: 'emulator-5556', state: 'device', model: 'Fake Device 2' },
    ];
  }
  const settings = loadSettings();
  const adb = findAdb({ userPath: settings.adbPath });
  if (!adb) {
    throw new Error('Không tìm thấy adb. Vui lòng cài đặt Android SDK hoặc cấu hình đường dẫn adb trong mục Nâng cao.');
  }
  return listDevices(adb.path);
});

ipcMain.handle('adb:listPackages', async (event, serial: unknown) => {
  verifySender(event);
  if (typeof serial !== 'string' || !serial) return [];
  if (isFake) {
    return ['com.example.app', 'com.fake.app'];
  }
  const settings = loadSettings();
  const adb = findAdb({ userPath: settings.adbPath });
  if (!adb) return [];
  return listPackages(adb.path, serial);
});

ipcMain.handle('emulator:listAvds', async (event) => {
  verifySender(event);
  if (isFake) return ['Pixel_8_API_34', 'Pixel_8_API_34_2'];
  const emu = findEmulator();
  if (!emu) return [];
  try {
    // parseAvdList đã lọc: chỉ trả về tên hợp lệ
    return await listAvds(emu.path);
  } catch {
    return [];
  }
});

ipcMain.handle('run:start', async (event, raw: unknown) => {
  verifySender(event);
  if (isRunning) {
    throw new Error('Đang có một tiến trình khám phá đang chạy.');
  }

  const rawObj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const defaultOutDir = join(app.getPath('documents'), 'SimCrawler', 'logs');
  const baseDir = join(app.getPath('documents'), 'SimCrawler');
  mkdirSync(defaultOutDir, { recursive: true });

  let blacklistArr: string[] = [];
  if (Array.isArray(rawObj.blacklist)) {
    blacklistArr = rawObj.blacklist.map((b) => String(b).trim()).filter(Boolean);
  } else if (typeof rawObj.blacklist === 'string') {
    blacklistArr = rawObj.blacklist.split(/[,;\n]+/).map((b) => b.trim()).filter(Boolean);
  }

  // Không tin renderer: chỉ nhận đúng hình dạng {autoStart, avds: {serial: chuỗi}}, phần còn lại
  // (cổng, tên AVD, serial thuộc devices) do validateConfig kiểm tra.
  let emulatorsRaw: Record<string, unknown> | undefined;
  const em = rawObj.emulators;
  if (em && typeof em === 'object' && !Array.isArray(em) && (em as Record<string, unknown>).autoStart === true) {
    const avdsIn = (em as Record<string, unknown>).avds;
    const avds: Record<string, unknown> = {};
    if (avdsIn && typeof avdsIn === 'object' && !Array.isArray(avdsIn)) {
      for (const [serial, avd] of Object.entries(avdsIn)) avds[serial] = avd;
    }
    const names = Object.values(avds);
    // Hai máy chung một AVD chỉ chạy được với -read-only.
    emulatorsRaw = { autoStart: true, avds, readOnly: new Set(names).size < names.length };
  }

  const rawCfg = {
    package: rawObj.package,
    devices: rawObj.devices,
    maxMinutes: rawObj.maxMinutes !== undefined ? Number(rawObj.maxMinutes) : 10,
    blacklist: blacklistArr,
    outDir: defaultOutDir,
    ...(emulatorsRaw ? { emulators: emulatorsRaw } : {}),
  };

  const cfg = validateConfig(rawCfg, baseDir);

  const userAdbPath = typeof rawObj.adbPath === 'string' && rawObj.adbPath.trim() ? rawObj.adbPath.trim() : undefined;
  saveSettings({
    package: cfg.package,
    devices: cfg.devices,
    maxMinutes: cfg.maxMinutes,
    blacklist: cfg.blacklist,
    adbPath: userAdbPath,
    ...(cfg.emulators ? { emulators: { autoStart: true, avds: cfg.emulators.avds } } : {}),
  });

  let devices: Device[];
  if (isFake) {
    cfg.launchWaitMs = Math.min(cfg.launchWaitMs, 200);
    devices = cfg.devices.map((s) => new FakeDevice(s, cfg.package));
  } else {
    const adb = findAdb({ userPath: userAdbPath });
    if (!adb) {
      throw new Error('Không tìm thấy adb. Vui lòng kiểm tra đường dẫn adb trong mục Nâng cao hoặc cài Android SDK.');
    }
    devices = cfg.devices.map((s) => new AdbDevice(s, adb.path));
  }

  // Giữ chỗ ngay từ đầu: bật emulator có thể mất vài phút, trong lúc đó không cho Start lần hai.
  const ctl: RunControl = { stopped: false };
  const abort = new AbortController();
  currentCtl = ctl;
  currentAbort = abort;
  isRunning = true;
  const release = (): void => {
    isRunning = false;
    currentCtl = null;
    currentAbort = null;
  };

  try {
    if (!isFake && cfg.emulators?.autoStart) {
      const emuBin = findEmulator();
      if (!emuBin) throw new Error('Không tìm thấy emulator. Cài Android SDK (thành phần Emulator) hoặc đặt ANDROID_HOME.');
      await startEmulators({
        emulators: cfg.emulators,
        adbPath: findAdb({ userPath: userAdbPath })?.path ?? 'adb',
        emulatorPath: emuBin.path,
        logDir: defaultOutDir,
        log: (m) => {
          if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('run:status', m);
        },
        signal: abort.signal,
      });
      if (ctl.stopped) throw new Error('Đã dừng khi đang khởi động emulator.');
    }

    const problems: string[] = [];
    await Promise.all(
      devices.map((d) =>
        d.ensureReady(cfg.package).catch((e: Error) => {
          problems.push(e.message);
        }),
      ),
    );
    if (problems.length) {
      throw new Error(problems.join('\n'));
    }
  } catch (e) {
    release();
    throw e;
  }

  const board = new Board();
  if (isFake) board.meta.package = `${cfg.package}  (thiết bị giả)`;
  currentBoard = board;

  board.on('update', (payload) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('run:update', payload);
    }
  });

  activeRunPromise = runCrawl({ cfg, devices, board, ctl });
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('run:started', { ...board.snapshot(), maxMinutes: cfg.maxMinutes });
  }

  activeRunPromise
    .then((summary) => {
      lastRunDir = summary.runDir;
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('run:finished', { ok: true, summary });
      }
    })
    .catch((err) => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('run:finished', { ok: false, error: err.message });
      }
    })
    .finally(() => {
      release();
      activeRunPromise = null;
    });

  return { ok: true };
});

ipcMain.handle('run:stop', async (event) => {
  verifySender(event);
  if (currentCtl) {
    currentCtl.stopped = true;
  }
  currentAbort?.abort();
  return { ok: true };
});

ipcMain.handle('run:getState', async (event) => {
  verifySender(event);
  return currentBoard ? currentBoard.snapshot() : { package: '', devices: [] };
});

ipcMain.handle('run:getShot', async (event, index: unknown) => {
  verifySender(event);
  const idx = typeof index === 'number' ? index : Number(index);
  if (!currentBoard || !currentBoard.devices[idx]) return null;
  return currentBoard.devices[idx].shot ?? null;
});

ipcMain.handle('run:openLogs', async (event) => {
  verifySender(event);
  const dir = lastRunDir || join(app.getPath('documents'), 'SimCrawler', 'logs');
  mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true };
});

// ------------------------------------------------------------ Lifecycle

let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  if (isRunning && currentCtl && activeRunPromise) {
    event.preventDefault();
    isQuitting = true;
    currentCtl.stopped = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([activeRunPromise, timeout]).finally(() => {
      app.quit();
    });
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
