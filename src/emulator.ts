import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AVD_RE, emulatorPort } from './config.js';
import type { EmulatorsConfig } from './types.js';

export interface FindEmulatorResult {
  path: string;
  source: string;
}

export interface FindEmulatorOptions {
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  home?: string;
  platform?: NodeJS.Platform;
}

export function findEmulator(opts: FindEmulatorOptions = {}): FindEmulatorResult | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const bin = platform === 'win32' ? 'emulator.exe' : 'emulator';

  for (const [name, source] of [
    ['ANDROID_HOME', 'ANDROID_HOME'],
    ['ANDROID_SDK_ROOT', 'ANDROID_SDK_ROOT'],
  ] as const) {
    const dir = env[name]?.trim();
    if (dir) {
      const p = join(dir, 'emulator', bin);
      if (exists(p)) return { path: p, source };
    }
  }

  const macSdk = join(home, 'Library', 'Android', 'sdk', 'emulator', bin);
  if (exists(macSdk)) return { path: macSdk, source: 'macos_sdk' };

  const linuxSdk = join(home, 'Android', 'Sdk', 'emulator', bin);
  if (exists(linuxSdk)) return { path: linuxSdk, source: 'android_sdk' };

  const localAppData = env.LOCALAPPDATA;
  const winSdk = localAppData
    ? join(localAppData, 'Android', 'Sdk', 'emulator', bin)
    : join(home, 'AppData', 'Local', 'Android', 'Sdk', 'emulator', bin);
  if (platform === 'win32' && exists(winSdk)) return { path: winSdk, source: 'windows_sdk' };

  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? '').split(sep).filter(Boolean)) {
    const candidate = join(dir, bin);
    if (exists(candidate)) return { path: candidate, source: 'path' };
  }
  return null;
}

/** Output của `emulator -list-avds`: mỗi dòng một tên AVD, có thể lẫn dòng INFO/WARNING. */
export function parseAvdList(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(INFO|WARNING|ERROR)\b/.test(line)) continue;
    if (AVD_RE.test(line)) names.push(line);
  }
  return names;
}

// ------------------------------------------------------------------ phụ thuộc có thể thay trong test

export interface SpawnedProcess {
  pid?: number;
  /** Mã thoát nếu process đã thoát, ngược lại null */
  exitCode(): number | null;
  kill(): void;
}

export interface EmulatorDeps {
  /** Chạy lệnh, trả stdout. Ném lỗi khi thoát khác 0 hoặc quá hạn. */
  exec(file: string, args: string[], timeoutMs: number): Promise<string>;
  /** Chạy process tách rời (không qua shell), không giữ nó sống cùng tiến trình này. */
  spawn(file: string, args: string[], logFile?: string): SpawnedProcess;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export const realDeps: EmulatorDeps = {
  exec: (file, args, timeout) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const tail = stderr && stderr.trim() ? ` | ${stderr.trim()}` : '';
          reject(new Error(`${file} ${args.join(' ')} thất bại: ${err.message}${tail}`));
        } else {
          resolve(stdout);
        }
      });
    }),
  spawn: (file, args, logFile) => {
    let fd: number | undefined;
    if (logFile) {
      try {
        mkdirSync(dirname(logFile), { recursive: true });
        fd = openSync(logFile, 'a');
      } catch {
        fd = undefined;
      }
    }
    const child: ChildProcess = nodeSpawn(file, args, {
      detached: true,
      stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
      shell: false,
    });
    if (fd !== undefined) closeSync(fd);
    let code: number | null = null;
    child.on('exit', (c, signal) => {
      code = c ?? (signal ? 1 : 0);
    });
    child.on('error', () => {
      code = 1;
    });
    child.unref();
    return { pid: child.pid, exitCode: () => code, kill: () => void child.kill() };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function listAvds(emulatorPath: string, deps: EmulatorDeps = realDeps): Promise<string[]> {
  return parseAvdList(await deps.exec(emulatorPath, ['-list-avds'], 15_000));
}

// ------------------------------------------------------------------ khởi động / tắt

export interface EnsureEmulatorOptions {
  serial: string;
  avd: string;
  adbPath: string;
  emulatorPath: string;
  headless?: boolean;
  readOnly?: boolean;
  bootTimeoutSec?: number;
  pollMs?: number;
  /** File ghi stdout/stderr của emulator (giúp biết vì sao nó thoát sớm) */
  logFile?: string;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  deps?: EmulatorDeps;
}

export interface EnsureEmulatorResult {
  serial: string;
  startedByUs: boolean;
}

export function emulatorArgs(avd: string, port: number, headless: boolean, readOnly: boolean): string[] {
  // Tuyệt đối không có -wipe-data: sẽ mất đăng nhập trong app.
  return [
    '-avd',
    avd,
    '-port',
    String(port),
    '-no-boot-anim',
    '-no-audio',
    '-no-snapshot-save',
    ...(headless ? ['-no-window'] : []),
    ...(readOnly ? ['-read-only'] : []),
  ];
}

export async function ensureEmulator(opts: EnsureEmulatorOptions): Promise<EnsureEmulatorResult> {
  const { serial, avd, adbPath, emulatorPath } = opts;
  const deps = opts.deps ?? realDeps;
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 2000;
  const timeoutSec = opts.bootTimeoutSec ?? 180;

  const port = emulatorPort(serial);
  if (port === null) throw new Error(`Serial "${serial}" không phải emulator-<cổng chẵn 5554..5584>, không thể tự bật`);
  if (!AVD_RE.test(avd)) throw new Error(`Tên AVD "${avd}" không hợp lệ`);

  const adb = (args: string[], timeout = 8_000) => deps.exec(adbPath, ['-s', serial, ...args], timeout);
  const getState = async (): Promise<string> => {
    try {
      return (await adb(['get-state'])).trim();
    } catch {
      return ''; // chưa có thiết bị nào ở cổng này
    }
  };

  const state0 = await getState();
  if (state0 === 'device') {
    try {
      const running = (await adb(['emu', 'avd', 'name'])).split(/\r?\n/)[0].trim();
      if (running && running !== avd) {
        log(`⚠ ${serial} đang chạy AVD "${running}", không phải "${avd}" như trong config. Dùng luôn máy đang chạy.`);
      }
    } catch {
      // không hỏi được tên AVD thì thôi, chỉ là cảnh báo
    }
    return { serial, startedByUs: false };
  }

  // Cổng đã có thiết bị nhưng chưa "device" (offline/đang boot do người khác bật): không bật cái thứ hai.
  let proc: SpawnedProcess | null = null;
  if (state0 === '') {
    proc = deps.spawn(emulatorPath, emulatorArgs(avd, port, !!opts.headless, !!opts.readOnly), opts.logFile);
  } else {
    log(`${serial} đang ở trạng thái "${state0}", chờ nó boot xong thay vì bật thêm một emulator.`);
  }

  const abandon = async (): Promise<void> => {
    if (!proc) return;
    proc.kill();
    // Launcher có thể đã sinh process qemu riêng; nhờ adb tắt luôn cho sạch.
    await killEmulator(adbPath, serial, deps).catch(() => {});
  };

  const start = deps.now();
  const deadline = start + timeoutSec * 1000;
  let lastStage = 'chờ thiết bị xuất hiện';
  for (;;) {
    if (opts.signal?.aborted) {
      await abandon();
      throw new Error(`Đã hủy khi đang khởi động ${serial} (${avd})`);
    }
    if (proc) {
      const code = proc.exitCode();
      if (code !== null && code !== 0) {
        const hint = opts.logFile ? ` Xem ${opts.logFile}.` : '';
        throw new Error(`Emulator ${serial} (AVD ${avd}) thoát sớm với mã ${code}.${hint}`);
      }
    }

    // Lần lượt: get-state = device, rồi sys.boot_completed = 1, rồi PackageManager chạy được.
    if ((await getState()) === 'device') {
      lastStage = 'chờ sys.boot_completed';
      const booted = await adb(['shell', 'getprop', 'sys.boot_completed']).then((s) => s.trim() === '1', () => false);
      if (booted) {
        lastStage = 'chờ PackageManager';
        const pmReady = await adb(['shell', 'pm', 'path', 'android'], 15_000).then(
          (s) => s.includes('package:'),
          () => false,
        );
        if (pmReady) return { serial, startedByUs: proc !== null };
      }
    }

    if (deps.now() >= deadline) {
      await abandon();
      throw new Error(
        `Emulator ${serial} (AVD ${avd}) chưa sẵn sàng sau ${timeoutSec}s (đang ${lastStage}). ` +
          'Tăng "emulators.bootTimeoutSec" nếu máy chậm.' +
          (opts.logFile ? ` Xem ${opts.logFile}.` : ''),
      );
    }
    await deps.sleep(pollMs);
  }
}

export async function killEmulator(adbPath: string, serial: string, deps: EmulatorDeps = realDeps): Promise<void> {
  await deps.exec(adbPath, ['-s', serial, 'emu', 'kill'], 10_000);
}

// ------------------------------------------------------------------ nhiều emulator song song

export interface StartEmulatorsOptions {
  emulators: EmulatorsConfig;
  adbPath: string;
  emulatorPath: string;
  /** Thư mục để ghi <serial>.emulator.log */
  logDir?: string;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  deps?: EmulatorDeps;
}

export interface EmulatorSession {
  /** Các serial do chính mình bật */
  started: string[];
  /** Tắt các emulator do chính mình bật (không đụng tới máy người dùng tự bật) */
  closeStarted(): Promise<void>;
}

export async function startEmulators(opts: StartEmulatorsOptions): Promise<EmulatorSession> {
  const { emulators, adbPath, emulatorPath } = opts;
  const deps = opts.deps ?? realDeps;
  const log = opts.log ?? (() => {});
  const entries = Object.entries(emulators.avds);

  // Một máy lỗi thì hủy các máy còn lại.
  const abort = new AbortController();
  opts.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  if (opts.signal?.aborted) abort.abort();

  const results = await Promise.allSettled(
    entries.map(async ([serial, avd]) => {
      const t0 = deps.now();
      log(`Đang khởi động ${serial} (${avd})...`);
      try {
        const r = await ensureEmulator({
          serial,
          avd,
          adbPath,
          emulatorPath,
          headless: emulators.headless,
          readOnly: emulators.readOnly,
          bootTimeoutSec: emulators.bootTimeoutSec,
          ...(opts.logDir ? { logFile: join(opts.logDir, `${serial}.emulator.log`) } : {}),
          log,
          signal: abort.signal,
          deps,
        });
        const secs = Math.round((deps.now() - t0) / 1000);
        log(
          r.startedByUs
            ? `${serial} (${avd}) xong sau ${secs}s`
            : `${serial} (${avd}) đã chạy sẵn, dùng luôn`,
        );
        return r;
      } catch (e) {
        abort.abort();
        throw e;
      }
    }),
  );

  const started = results.flatMap((r) => (r.status === 'fulfilled' && r.value.startedByUs ? [r.value.serial] : []));
  const session: EmulatorSession = {
    started,
    closeStarted: async () => {
      await Promise.all(
        started.map((serial) =>
          killEmulator(adbPath, serial, deps).then(
            () => log(`Đã tắt ${serial}`),
            (e: Error) => log(`⚠ Không tắt được ${serial}: ${e.message}`),
          ),
        ),
      );
    },
  };

  const failures = results.flatMap((r, i) =>
    r.status === 'rejected' ? [{ serial: entries[i][0], error: r.reason as Error }] : [],
  );
  if (failures.length) {
    // Chạy dở thì dọn máy mình đã bật nếu người dùng muốn tắt khi xong.
    if (emulators.closeWhenDone) await session.closeStarted();
    // Máy bị hủy do máy khác lỗi chỉ là hệ quả, báo máy gây lỗi trước.
    const primary = failures.filter((f) => !/^Đã hủy/.test(f.error.message));
    const shown = primary.length ? primary : failures;
    throw new Error(shown.map((f) => `✗ ${f.serial}: ${f.error.message}`).join('\n'));
  }
  return session;
}
