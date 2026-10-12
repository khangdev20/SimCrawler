import { parseArgs } from 'node:util';
import { AdbDevice } from './adb.js';
import { findAdb } from './adb-path.js';
import { Board } from './board.js';
import { loadConfig } from './config.js';
import { startDashboard, type DashboardHandle } from './dashboard.js';
import { findEmulator, listAvds, startEmulators, type EmulatorSession } from './emulator.js';
import type { RunControl } from './explorer.js';
import { FakeDevice } from './fake.js';
import { runCrawl } from './run.js';
import type { Device } from './types.js';

const HELP = `SimCrawler: tự động khám phá app Android trên nhiều thiết bị, ghi log JSONL.

Dùng:  npm start -- [tùy chọn]

  -c, --config <file>   file cấu hình (mặc định config.json)
      --minutes <n>     ghi đè maxMinutes
      --delay <ms>      ghi đè stepDelayMs
      --port <n>        ghi đè cổng dashboard
      --no-dashboard    không mở dashboard
      --keep            giữ dashboard sau khi chạy xong cho tới khi Ctrl-C
      --fake            dùng thiết bị giả, không cần adb (để thử dashboard)
      --start-emulators tự bật các AVD trong "emulators.avds" (kể cả khi config không bật autoStart)
      --list-avds       in danh sách AVD trên máy rồi thoát
  -h, --help
`;

function positive(name: string, v: string | undefined, allowZero = false): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new Error(`--${name} phải là số ${allowZero ? '>= 0' : '> 0'}`);
  }
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: 'config.json' },
      minutes: { type: 'string' },
      delay: { type: 'string' },
      port: { type: 'string' },
      'no-dashboard': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      fake: { type: 'boolean', default: false },
      'start-emulators': { type: 'boolean', default: false },
      'list-avds': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  if (values['list-avds']) {
    const emu = findEmulator();
    if (!emu) {
      throw new Error('Không tìm thấy emulator. Cài Android SDK (thành phần Emulator) hoặc đặt ANDROID_HOME.');
    }
    const avds = await listAvds(emu.path);
    console.log(avds.length ? avds.join('\n') : '(chưa có AVD nào, tạo bằng Android Studio > Device Manager)');
    return 0;
  }

  const cfg = loadConfig(values.config ?? 'config.json');
  cfg.maxMinutes = positive('minutes', values.minutes) ?? cfg.maxMinutes;
  cfg.stepDelayMs = positive('delay', values.delay, true) ?? cfg.stepDelayMs;
  cfg.dashboardPort = positive('port', values.port, true) ?? cfg.dashboardPort;
  if (values.fake) cfg.launchWaitMs = Math.min(cfg.launchWaitMs, 200);

  const adbPath = findAdb()?.path ?? 'adb';
  const devices: Device[] = cfg.devices.map((s) =>
    values.fake ? new FakeDevice(s, cfg.package) : new AdbDevice(s, adbPath),
  );

  const ctl: RunControl = { stopped: false };
  const startAbort = new AbortController();
  process.on('SIGINT', () => {
    if (ctl.stopped) process.exit(130);
    ctl.stopped = true;
    startAbort.abort();
    console.log('\nĐang dừng, ghi summary… (Ctrl-C lần nữa để thoát ngay)');
  });

  // Chế độ --fake không đụng tới emulator.
  let session: EmulatorSession | null = null;
  const emu = cfg.emulators;
  if (!values.fake && (values['start-emulators'] || emu?.autoStart)) {
    if (!emu || Object.keys(emu.avds).length === 0) {
      throw new Error('--start-emulators cần "emulators.avds" trong config.json (serial -> tên AVD)');
    }
    const found = findEmulator();
    if (!found) {
      throw new Error('Không tìm thấy emulator. Cài Android SDK (thành phần Emulator) hoặc đặt ANDROID_HOME.');
    }
    try {
      session = await startEmulators({
        emulators: emu,
        adbPath,
        emulatorPath: found.path,
        logDir: cfg.outDir,
        log: (m) => console.log(m),
        signal: startAbort.signal,
      });
    } catch (e) {
      // Lỗi ở đây xảy ra trước khi tạo thư mục run.
      console.error((e as Error).message);
      return ctl.stopped ? 130 : 1;
    }
  }

  try {
    // Kiểm tra sớm: thiết bị online và app đã cài, trước khi tạo thư mục log.
    const problems: string[] = [];
    await Promise.all(
      devices.map((d) =>
        d.ensureReady(cfg.package).catch((e: Error) => {
          problems.push(e.message);
        }),
      ),
    );
    if (problems.length) {
      console.error(problems.map((p) => `✗ ${p}`).join('\n'));
      return 1;
    }

    const board = new Board();
    if (values.fake) board.meta.package = cfg.package + '  (thiết bị giả)';

    let dash: DashboardHandle | null = null;
    if (!values['no-dashboard']) {
      try {
        dash = await startDashboard(board, cfg.dashboardPort);
        console.log(`Dashboard: ${dash.url}`);
      } catch (e) {
        console.warn(`Không mở được dashboard (${(e as Error).message}), vẫn chạy tiếp.`);
      }
    }

    console.log(`Chạy ${cfg.package} trên ${devices.map((d) => d.serial).join(', ')} trong tối đa ${cfg.maxMinutes} phút`);
    const summary = await runCrawl({ cfg, devices, board, ctl });
    const summaries = summary.devices;
    const runDir = summary.runDir;

    const STOP: Record<string, string> = {
      time: 'hết giờ',
      steps: 'đủ số bước',
      saturated: 'hết thứ để thử',
      interrupted: 'bị dừng tay',
      device_error: 'lỗi thiết bị',
    };
    console.log('');
    for (const s of summaries) {
      console.log(
        `${s.serial.padEnd(16)} ${String(s.steps).padStart(4)} bước · ${String(s.uniqueScreens).padStart(3)} màn hình · ` +
          `${s.crashes} crash · ${s.anrs} ANR · ${s.relaunches} lần mở lại · ${STOP[s.stopReason] ?? s.stopReason}` +
          (s.untriedElements ? ` · còn ${s.untriedElements} phần tử chưa thử` : ''),
      );
    }
    console.log(`\nLog + summary: ${runDir}`);

    if (dash) {
      if (values.keep && !ctl.stopped) {
        console.log(`Dashboard vẫn mở tại ${dash.url} (Ctrl-C để thoát)`);
        await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      }
      await dash.close();
    }
    return summaries.some((s) => s.stopReason === 'device_error') ? 2 : 0;
  } finally {
    if (session && emu?.closeWhenDone) await session.closeStarted();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
