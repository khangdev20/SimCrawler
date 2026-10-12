import { execFile } from 'node:child_process';
import { PKG_RE } from './config.js';
import type { Device } from './types.js';

interface AdbError extends Error {
  exitCode?: number;
}

function run(adb: string, args: string[], timeout: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      adb,
      args,
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const tail = stderr && stderr.length ? ` | ${stderr.toString().trim()}` : '';
          const e: AdbError = new Error(`adb ${args.join(' ')} thất bại: ${err.message}${tail}`);
          e.exitCode = typeof err.code === 'number' ? err.code : undefined;
          reject(e);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface DeviceInfo {
  serial: string;
  state: string;
  model?: string;
}

export function parseDevices(text: string): DeviceInfo[] {
  const lines = text.split(/\r?\n/);
  const result: DeviceInfo[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('* daemon')) continue;
    if (line.startsWith('List of devices attached')) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const serial = parts[0];
      const state = parts[1];
      const modelMatch = /\bmodel:(\S+)/.exec(line);
      const model = modelMatch ? modelMatch[1] : undefined;
      result.push({ serial, state, ...(model ? { model } : {}) });
    }
  }
  return result;
}

export async function listDevices(adbPath = 'adb'): Promise<DeviceInfo[]> {
  const buf = await run(adbPath, ['devices', '-l'], 10_000);
  return parseDevices(buf.toString('utf8'));
}

export async function listPackages(adbPath: string, serial: string): Promise<string[]> {
  const buf = await run(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], 15_000);
  const text = buf.toString('utf8');
  const pkgs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^package:(.+)$/.exec(line);
    if (m) {
      const name = m[1].trim();
      if (PKG_RE.test(name)) {
        pkgs.push(name);
      }
    }
  }
  pkgs.sort();
  return pkgs;
}

/**
 * Thiết bị thật qua adb. Package và serial đã được config.ts kiểm tra
 * (chỉ ký tự an toàn) vì package được ghép vào lệnh shell trên thiết bị.
 */
export class AdbDevice implements Device {
  constructor(
    readonly serial: string,
    private readonly adb: string = process.env.ADB_PATH || 'adb',
  ) {}

  private exec(args: string[], timeout = 20_000): Promise<Buffer> {
    return run(this.adb, ['-s', this.serial, ...args], timeout);
  }

  private async sh(cmd: string, timeout?: number): Promise<string> {
    return (await this.exec(['shell', cmd], timeout)).toString('utf8');
  }

  async ensureReady(pkg: string): Promise<void> {
    let state: string;
    try {
      state = (await this.exec(['get-state'], 8_000)).toString().trim();
    } catch (e) {
      throw new Error(`Không kết nối được thiết bị ${this.serial}: ${(e as Error).message}`);
    }
    if (state !== 'device') {
      throw new Error(`Thiết bị ${this.serial} đang ở trạng thái "${state}" (cần "device")`);
    }
    const list = await this.sh(`pm list packages ${pkg}`);
    if (!list.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`)) {
      throw new Error(`App ${pkg} chưa được cài trên ${this.serial}`);
    }
  }

  async dumpUi(): Promise<string> {
    return (await this.exec(['exec-out', 'uiautomator dump /dev/tty'], 30_000)).toString('utf8');
  }

  screencap(): Promise<Buffer> {
    return this.exec(['exec-out', 'screencap -p'], 20_000);
  }

  async focusedActivity(): Promise<string> {
    try {
      return (await this.sh('dumpsys window | grep mCurrentFocus')).trim();
    } catch {
      return '';
    }
  }

  async pid(pkg: string): Promise<string> {
    try {
      return (await this.sh(`pidof ${pkg}`)).trim().split(/\s+/)[0] ?? '';
    } catch (e) {
      // pidof thoát với mã 1 khi không có process. Lỗi khác (offline, timeout) phải nổi lên.
      if ((e as AdbError).exitCode === 1) return '';
      throw e;
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await this.sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms)}`);
  }

  async back(): Promise<void> {
    await this.sh('input keyevent 4');
  }

  async inputText(text: string): Promise<void> {
    const safe = text.replace(/ /g, '%s').replace(/[^A-Za-z0-9@._%-]/g, '');
    if (safe) await this.sh(`input text '${safe}'`);
  }

  async keyboardShown(): Promise<boolean> {
    try {
      return (await this.sh('dumpsys input_method | grep mInputShown')).includes('mInputShown=true');
    } catch {
      return false;
    }
  }

  async forceStop(pkg: string): Promise<void> {
    await this.sh(`am force-stop ${pkg}`);
  }

  async launch(pkg: string): Promise<void> {
    await this.sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }

  async crashLog(): Promise<string> {
    try {
      return await this.sh('logcat -b crash -d -t 200');
    } catch {
      return '';
    }
  }

  async clearCrashLog(): Promise<void> {
    await this.sh('logcat -b crash -c');
  }
}
