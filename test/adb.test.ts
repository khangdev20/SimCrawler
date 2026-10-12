import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDevices } from '../src/adb.js';
import { findAdb } from '../src/adb-path.js';
import { Board } from '../src/board.js';
import { FakeDevice } from '../src/fake.js';
import { runCrawl } from '../src/run.js';
import type { Config } from '../src/types.js';

test('findAdb: thứ tự ưu tiên với exists được tiêm', () => {
  // 1. User path
  assert.deepEqual(
    findAdb({
      userPath: '/custom/adb',
      exists: (p) => p === '/custom/adb',
    }),
    { path: '/custom/adb', source: 'user' },
  );

  // 2. env ADB_PATH
  assert.deepEqual(
    findAdb({
      env: { ADB_PATH: '/env/adb' },
      exists: (p) => p === '/env/adb',
    }),
    { path: '/env/adb', source: 'ADB_PATH' },
  );

  // 3. ANDROID_HOME và ANDROID_SDK_ROOT
  assert.deepEqual(
    findAdb({
      env: { ANDROID_HOME: '/sdk/home' },
      platform: 'linux',
      exists: (p) => p === '/sdk/home/platform-tools/adb',
    }),
    { path: '/sdk/home/platform-tools/adb', source: 'ANDROID_HOME' },
  );

  assert.deepEqual(
    findAdb({
      env: { ANDROID_SDK_ROOT: '/sdk/root' },
      platform: 'linux',
      exists: (p) => p === '/sdk/root/platform-tools/adb',
    }),
    { path: '/sdk/root/platform-tools/adb', source: 'ANDROID_SDK_ROOT' },
  );

  // 4. ~/Library/Android/sdk/platform-tools/adb (macOS)
  assert.deepEqual(
    findAdb({
      home: '/Users/test',
      platform: 'darwin',
      exists: (p) => p === '/Users/test/Library/Android/sdk/platform-tools/adb',
    }),
    { path: '/Users/test/Library/Android/sdk/platform-tools/adb', source: 'macos_sdk' },
  );

  // 5. ~/Android/Sdk/platform-tools/adb (Linux)
  assert.deepEqual(
    findAdb({
      home: '/home/test',
      platform: 'linux',
      exists: (p) => p === '/home/test/Android/Sdk/platform-tools/adb',
    }),
    { path: '/home/test/Android/Sdk/platform-tools/adb', source: 'android_sdk' },
  );

  // 6. /opt/homebrew/bin/adb
  assert.deepEqual(
    findAdb({
      platform: 'darwin',
      exists: (p) => p === '/opt/homebrew/bin/adb',
    }),
    { path: '/opt/homebrew/bin/adb', source: 'homebrew' },
  );

  // 7. /usr/local/bin/adb
  assert.deepEqual(
    findAdb({
      platform: 'darwin',
      exists: (p) => p === '/usr/local/bin/adb',
    }),
    { path: '/usr/local/bin/adb', source: 'usr_local' },
  );

  // 8. PATH
  assert.deepEqual(
    findAdb({
      env: { PATH: '/usr/bin:/bin' },
      platform: 'linux',
      exists: (p) => p === '/bin/adb',
    }),
    { path: 'adb', source: 'path' },
  );

  // Không tìm thấy
  assert.equal(
    findAdb({
      env: { PATH: '' },
      exists: () => false,
    }),
    null,
  );
});

test('parseDevices: bỏ qua daemon và header, phân tích thiết bị unauthorized/offline/device', () => {
  const text = `* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:Pixel_6 device:emu transport_id:1
emulator-5556          offline transport_id:2
192.168.1.100:5555     unauthorized transport_id:3
`;

  const devices = parseDevices(text);
  assert.equal(devices.length, 3);
  assert.deepEqual(devices[0], {
    serial: 'emulator-5554',
    state: 'device',
    model: 'Pixel_6',
  });
  assert.deepEqual(devices[1], {
    serial: 'emulator-5556',
    state: 'offline',
  });
  assert.deepEqual(devices[2], {
    serial: '192.168.1.100:5555',
    state: 'unauthorized',
  });
});

test('runCrawl với FakeDevice: tạo summary.json và đăng ký thiết bị trên board', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'simcrawler-runcrawl-'));
  const cfg: Config = {
    package: 'com.fake.app',
    devices: ['fake-dev-1', 'fake-dev-2'],
    maxMinutes: 1,
    blacklist: [],
    stepDelayMs: 0,
    launchWaitMs: 0,
    staleStepsBeforeRelaunch: 15,
    maxSteps: 2,
    dashboardPort: 0,
    seed: 42,
    outDir,
  };

  const board = new Board();
  const devices = [
    new FakeDevice('fake-dev-1', cfg.package),
    new FakeDevice('fake-dev-2', cfg.package),
  ];

  const summary = await runCrawl({ cfg, devices, board, ctl: { stopped: false } });

  assert.equal(board.devices.length, 2);
  assert.equal(board.devices[0].serial, 'fake-dev-1');
  assert.equal(board.devices[1].serial, 'fake-dev-2');
  assert.equal(board.meta.package, 'com.fake.app');

  assert.equal(summary.package, 'com.fake.app');
  assert.equal(summary.devices.length, 2);
  assert.ok(existsSync(join(summary.runDir, 'summary.json')));

  const parsed = JSON.parse(readFileSync(join(summary.runDir, 'summary.json'), 'utf8'));
  assert.equal(parsed.package, 'com.fake.app');
  assert.equal(parsed.devices.length, 2);
});
