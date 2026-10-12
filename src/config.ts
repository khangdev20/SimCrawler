import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config, EmulatorsConfig } from './types.js';

// package và serial được ghép vào lệnh shell trên thiết bị, nên kiểm tra chặt.
export const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const SERIAL_RE = /^[A-Za-z0-9_.:-]+$/;
// Tên AVD đi vào đối số của emulator, nên chỉ cho ký tự an toàn và không được bắt đầu bằng '-'
// (để không bị hiểu thành một cờ).
export const AVD_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
export const EMULATOR_SERIAL_RE = /^emulator-(\d+)$/;
export const MIN_EMULATOR_PORT = 5554;
export const MAX_EMULATOR_PORT = 5584;

/** Cổng console của serial emulator-<cổng>, hoặc null nếu không phải cổng hợp lệ (chẵn, 5554..5584). */
export function emulatorPort(serial: string): number | null {
  const m = EMULATOR_SERIAL_RE.exec(serial);
  if (!m) return null;
  const port = Number(m[1]);
  if (port % 2 !== 0 || port < MIN_EMULATOR_PORT || port > MAX_EMULATOR_PORT) return null;
  return port;
}

function parseEmulators(raw: unknown, devices: unknown, errors: string[]): EmulatorsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"emulators" phải là một object, ví dụ {"autoStart": true, "avds": {"emulator-5554": "Pixel_8_API_34"}}');
    return undefined;
  }
  const e = raw as Record<string, unknown>;
  const bool = (key: string): boolean => {
    const v = e[key];
    if (v === undefined) return false;
    if (typeof v !== 'boolean') {
      errors.push(`"emulators.${key}" phải là true hoặc false`);
      return false;
    }
    return v;
  };

  const autoStart = bool('autoStart');
  const headless = bool('headless');
  const closeWhenDone = bool('closeWhenDone');
  const readOnly = bool('readOnly');

  let bootTimeoutSec = 180;
  if (e.bootTimeoutSec !== undefined) {
    const v = e.bootTimeoutSec;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      errors.push('"emulators.bootTimeoutSec" phải là số > 0');
    } else {
      bootTimeoutSec = v;
    }
  }

  const avds: Record<string, string> = {};
  if (e.avds !== undefined) {
    if (!e.avds || typeof e.avds !== 'object' || Array.isArray(e.avds)) {
      errors.push('"emulators.avds" phải là object dạng {"emulator-5554": "Tên_AVD"}');
    } else {
      const deviceList = Array.isArray(devices) ? (devices as unknown[]) : null;
      for (const [serial, avd] of Object.entries(e.avds as Record<string, unknown>)) {
        if (emulatorPort(serial) === null) {
          errors.push(
            `"emulators.avds": khóa "${serial}" phải có dạng emulator-<cổng>, cổng chẵn từ ${MIN_EMULATOR_PORT} đến ${MAX_EMULATOR_PORT}`,
          );
          continue;
        }
        if (deviceList && !deviceList.includes(serial)) {
          errors.push(`"emulators.avds": serial "${serial}" không có trong "devices"`);
          continue;
        }
        if (typeof avd !== 'string' || !AVD_RE.test(avd)) {
          errors.push(
            `"emulators.avds": tên AVD của "${serial}" chỉ được gồm chữ, số, '_', '.', '-' (và không bắt đầu bằng '-')`,
          );
          continue;
        }
        avds[serial] = avd;
      }
      // Hai bản của cùng một AVD chỉ chạy song song được khi có -read-only.
      const bySerial = new Map<string, string[]>();
      for (const [serial, avd] of Object.entries(avds)) bySerial.set(avd, [...(bySerial.get(avd) ?? []), serial]);
      for (const [avd, serials] of bySerial) {
        if (serials.length > 1 && !readOnly) {
          errors.push(
            `${serials.join(' và ')} cùng dùng AVD "${avd}": cần "emulators.readOnly": true ` +
              '(emulator chỉ cho chạy nhiều bản của một AVD khi có -read-only), hoặc dùng hai AVD khác nhau',
          );
        }
      }
    }
  }
  if (autoStart && Object.keys(avds).length === 0 && !errors.some((m) => m.includes('emulators.avds'))) {
    errors.push('"emulators.autoStart" bật nhưng "emulators.avds" trống: cần ánh xạ serial -> tên AVD');
  }

  return { autoStart, avds, headless, bootTimeoutSec, closeWhenDone, readOnly };
}

export function validateConfig(raw: unknown, baseDir: string): Config {
  const errors: string[] = [];
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const num = (key: string, def: number, min: number, strict = false): number => {
    const v = o[key];
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v) || (strict ? v <= min : v < min)) {
      errors.push(`"${key}" phải là số ${strict ? '>' : '>='} ${min}`);
      return def;
    }
    return v;
  };

  const pkg = o.package;
  if (typeof pkg !== 'string' || !PKG_RE.test(pkg)) {
    errors.push('"package" phải là tên package hợp lệ, ví dụ com.example.app');
  }

  const devices = o.devices;
  if (
    !Array.isArray(devices) ||
    devices.length === 0 ||
    !devices.every((d) => typeof d === 'string' && SERIAL_RE.test(d))
  ) {
    errors.push('"devices" phải là mảng serial không rỗng, ví dụ ["emulator-5554", "emulator-5556"]');
  } else if (new Set(devices).size !== devices.length) {
    errors.push('"devices" có serial bị trùng');
  }

  let blacklist: string[] = [];
  if (o.blacklist !== undefined) {
    if (Array.isArray(o.blacklist) && o.blacklist.every((b) => typeof b === 'string')) {
      blacklist = (o.blacklist as string[]).map((b) => b.trim()).filter(Boolean);
    } else {
      errors.push('"blacklist" phải là mảng chuỗi');
    }
  }

  const outDir = o.outDir === undefined ? 'logs' : o.outDir;
  if (typeof outDir !== 'string' || !outDir) errors.push('"outDir" phải là chuỗi');

  const emulators = parseEmulators(o.emulators, devices, errors);

  const cfg: Config = {
    package: String(pkg),
    devices: Array.isArray(devices) ? (devices as string[]) : [],
    maxMinutes: num('maxMinutes', 10, 0, true),
    blacklist,
    stepDelayMs: num('stepDelayMs', 800, 0),
    launchWaitMs: num('launchWaitMs', 2000, 0),
    staleStepsBeforeRelaunch: Math.floor(num('staleStepsBeforeRelaunch', 15, 1)),
    maxSteps: Math.floor(num('maxSteps', 0, 0)),
    dashboardPort: Math.floor(num('dashboardPort', 8765, 0)),
    seed: Math.floor(num('seed', 1337, 0)),
    outDir: resolve(baseDir, typeof outDir === 'string' ? outDir : 'logs'),
    ...(emulators ? { emulators } : {}),
  };

  if (errors.length) throw new Error('config.json không hợp lệ:\n - ' + errors.join('\n - '));
  return cfg;
}

export function loadConfig(file: string): Config {
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Không đọc được ${path}: ${(e as Error).message}`);
  }
  return validateConfig(raw, dirname(path));
}
