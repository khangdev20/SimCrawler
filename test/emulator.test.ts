import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config.js';
import {
  emulatorArgs,
  ensureEmulator,
  findEmulator,
  killEmulator,
  parseAvdList,
  startEmulators,
  type EmulatorDeps,
  type SpawnedProcess,
} from '../src/emulator.js';

test('findEmulator: thứ tự ưu tiên với exists được tiêm', () => {
  assert.deepEqual(
    findEmulator({
      env: { ANDROID_HOME: '/sdk/home', ANDROID_SDK_ROOT: '/sdk/root' },
      platform: 'linux',
      exists: (p) => p === '/sdk/home/emulator/emulator' || p === '/sdk/root/emulator/emulator',
    }),
    { path: '/sdk/home/emulator/emulator', source: 'ANDROID_HOME' },
  );
  assert.deepEqual(
    findEmulator({
      env: { ANDROID_SDK_ROOT: '/sdk/root' },
      platform: 'linux',
      exists: (p) => p === '/sdk/root/emulator/emulator',
    }),
    { path: '/sdk/root/emulator/emulator', source: 'ANDROID_SDK_ROOT' },
  );
  assert.deepEqual(
    findEmulator({
      env: {},
      home: '/Users/t',
      platform: 'darwin',
      exists: (p) => p === '/Users/t/Library/Android/sdk/emulator/emulator',
    }),
    { path: '/Users/t/Library/Android/sdk/emulator/emulator', source: 'macos_sdk' },
  );
  assert.deepEqual(
    findEmulator({
      env: {},
      home: '/home/t',
      platform: 'linux',
      exists: (p) => p === '/home/t/Android/Sdk/emulator/emulator',
    }),
    { path: '/home/t/Android/Sdk/emulator/emulator', source: 'android_sdk' },
  );
  assert.deepEqual(
    findEmulator({
      env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
      home: 'C:\\Users\\t',
      platform: 'win32',
      exists: (p) => p === 'C:\\Users\\t\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe',
    }),
    { path: 'C:\\Users\\t\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe', source: 'windows_sdk' },
  );
  assert.deepEqual(
    findEmulator({ env: { PATH: '/usr/bin:/opt/x' }, home: '/h', platform: 'linux', exists: (p) => p === '/opt/x/emulator' }),
    { path: '/opt/x/emulator', source: 'path' },
  );
  assert.equal(findEmulator({ env: { PATH: '' }, home: '/h', exists: () => false }), null);
});

test('parseAvdList: bỏ dòng trống và dòng INFO', () => {
  const text = 'INFO    | Storing crashdata in: /tmp/x, detection is enabled for process: 1\nPixel_9\n\n  Pixel_10  \nWARNING | something\r\n';
  assert.deepEqual(parseAvdList(text), ['Pixel_9', 'Pixel_10']);
  assert.deepEqual(parseAvdList(''), []);
});

test('validateConfig: khối emulators', () => {
  const base = { package: 'com.example.app', devices: ['emulator-5554', 'emulator-5556'] };
  const bad = (emulators: unknown, re: RegExp) =>
    assert.throws(() => validateConfig({ ...base, emulators }, '/x'), re);

  // không có khối emulators thì không thêm gì
  assert.equal(validateConfig(base, '/x').emulators, undefined);

  const ok = validateConfig(
    { ...base, emulators: { autoStart: true, avds: { 'emulator-5554': 'Pixel_8_API_34', 'emulator-5556': 'Pixel_8_API_34_2' } } },
    '/x',
  );
  assert.deepEqual(ok.emulators, {
    autoStart: true,
    avds: { 'emulator-5554': 'Pixel_8_API_34', 'emulator-5556': 'Pixel_8_API_34_2' },
    headless: false,
    bootTimeoutSec: 180,
    closeWhenDone: false,
    readOnly: false,
  });

  bad({ avds: { 'emulator-5555': 'A' } }, /cổng chẵn/); // cổng lẻ
  bad({ avds: { 'emulator-5586': 'A' } }, /cổng chẵn/); // ngoài khoảng
  bad({ avds: { 'emulator-5552': 'A' } }, /cổng chẵn/);
  bad({ avds: { 'pixel-5554': 'A' } }, /emulator-<cổng>/);
  bad({ avds: { 'emulator-5558': 'A' } }, /không có trong "devices"/);
  bad({ avds: { 'emulator-5554': 'Pixel 8; rm -rf' } }, /tên AVD/);
  bad({ avds: { 'emulator-5554': '-wipe-data' } }, /tên AVD/);
  bad({ avds: { 'emulator-5554': 5 } }, /tên AVD/);
  bad({ avds: { 'emulator-5554': 'Same', 'emulator-5556': 'Same' } }, /readOnly/);
  bad({ autoStart: true }, /avds/);
  bad({ autoStart: 'yes', avds: {} }, /autoStart/);
  bad({ bootTimeoutSec: 0 }, /bootTimeoutSec/);
  bad('nope', /"emulators"/);

  // cùng AVD nhưng readOnly thì hợp lệ
  const ro = validateConfig(
    { ...base, emulators: { readOnly: true, avds: { 'emulator-5554': 'Same', 'emulator-5556': 'Same' } } },
    '/x',
  );
  assert.equal(ro.emulators?.readOnly, true);
});

// ---------------------------------------------------------------- ensureEmulator với adb/emulator giả

interface Fake {
  deps: EmulatorDeps;
  calls: string[][];
  spawned: { file: string; args: string[] }[];
  killed: { n: number };
  clock: { t: number };
}

/** script: trả lời cho mỗi lệnh adb theo tên lệnh; hàm được gọi lại mỗi lần để mô phỏng trạng thái đổi theo thời gian. */
function fake(
  answer: (cmd: string, clock: { t: number }, spawnedAt: number | null) => string | Error,
  exitCode: () => number | null = () => null,
): Fake {
  const calls: string[][] = [];
  const spawned: { file: string; args: string[] }[] = [];
  const killed = { n: 0 };
  const clock = { t: 0 };
  let spawnedAt: number | null = null;
  const deps: EmulatorDeps = {
    exec: async (_file, args) => {
      calls.push(args);
      const rest = args.slice(2); // bỏ -s <serial>
      const cmd = rest.join(' ');
      if (cmd === 'emu kill') {
        return 'OK';
      }
      const r = answer(cmd, clock, spawnedAt);
      if (r instanceof Error) throw r;
      return r;
    },
    spawn: (file, args) => {
      spawned.push({ file, args });
      spawnedAt = clock.t;
      const p: SpawnedProcess = { pid: 123, exitCode, kill: () => void killed.n++ };
      return p;
    },
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls, spawned, killed, clock };
}

const base = { serial: 'emulator-5554', avd: 'Pixel_8_API_34', adbPath: 'adb', emulatorPath: '/sdk/emulator/emulator' };

test('ensureEmulator (a): đã online thì không spawn, và cảnh báo nếu cổng chạy AVD khác', async () => {
  const f = fake((cmd) => {
    if (cmd === 'get-state') return 'device\n';
    if (cmd === 'emu avd name') return 'Other_AVD\nOK\n';
    return new Error('không được gọi');
  });
  const logs: string[] = [];
  const r = await ensureEmulator({ ...base, deps: f.deps, log: (m) => logs.push(m) });
  assert.deepEqual(r, { serial: 'emulator-5554', startedByUs: false });
  assert.equal(f.spawned.length, 0);
  assert.ok(logs.some((l) => l.includes('Other_AVD') && l.includes('Pixel_8_API_34')));

  // cùng AVD thì im lặng
  const f2 = fake((cmd) => (cmd === 'get-state' ? 'device' : 'Pixel_8_API_34\nOK'));
  const logs2: string[] = [];
  await ensureEmulator({ ...base, deps: f2.deps, log: (m) => logs2.push(m) });
  assert.equal(logs2.length, 0);
});

test('ensureEmulator: cổng đã có thiết bị offline thì chờ chứ không bật cái thứ hai', async () => {
  let polls = 0;
  const f = fake((cmd) => {
    if (cmd === 'get-state') return ++polls < 3 ? 'offline' : 'device';
    if (cmd === 'shell getprop sys.boot_completed') return '1\n';
    if (cmd === 'shell pm path android') return 'package:/system/framework/framework-res.apk\n';
    return new Error('?');
  });
  const r = await ensureEmulator({ ...base, deps: f.deps });
  assert.equal(f.spawned.length, 0);
  assert.equal(r.startedByUs, false);
});

test('ensureEmulator (b): spawn đúng đối số rồi chờ offline → device → boot_completed → pm', async () => {
  // get-state theo thời gian: lúc đầu không có máy, rồi offline, rồi device
  // boot_completed: 0 rồi 1; pm: lỗi rồi OK
  let bootPolls = 0;
  let pmPolls = 0;
  const f = fake((cmd, clock, spawnedAt) => {
    if (cmd === 'get-state') {
      if (spawnedAt === null) return new Error('device not found');
      const elapsed = clock.t - spawnedAt;
      return elapsed < 4000 ? new Error('device not found') : elapsed < 8000 ? 'offline\n' : 'device\n';
    }
    if (cmd === 'shell getprop sys.boot_completed') return ++bootPolls < 3 ? '\n' : '1\n';
    if (cmd === 'shell pm path android') {
      return ++pmPolls < 2 ? new Error("Can't find service: package") : 'package:/system/framework/framework-res.apk\n';
    }
    return new Error('lệnh lạ: ' + cmd);
  });
  const logs: string[] = [];
  const r = await ensureEmulator({
    ...base,
    headless: true,
    readOnly: true,
    deps: f.deps,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(r, { serial: 'emulator-5554', startedByUs: true });
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].file, '/sdk/emulator/emulator');
  assert.deepEqual(f.spawned[0].args, [
    '-avd', 'Pixel_8_API_34', '-port', '5554', '-no-boot-anim', '-no-audio', '-no-snapshot-save', '-no-window', '-read-only',
  ]);
  assert.ok(!f.spawned[0].args.includes('-wipe-data'));
  // đã đi qua đủ các bước, theo thứ tự
  const seq = f.calls.map((c) => c.slice(2).join(' '));
  const firstBoot = seq.indexOf('shell getprop sys.boot_completed');
  const firstPm = seq.indexOf('shell pm path android');
  assert.ok(firstBoot > 0 && firstPm > firstBoot);
  assert.ok(f.clock.t >= 8000); // chờ qua trạng thái offline
  assert.equal(f.killed.n, 0);
});

test('emulatorArgs: không -no-window / -read-only khi không bật', () => {
  const a = emulatorArgs('X', 5556, false, false);
  assert.deepEqual(a, ['-avd', 'X', '-port', '5556', '-no-boot-anim', '-no-audio', '-no-snapshot-save']);
});

test('ensureEmulator (c): quá hạn thì kill process vừa spawn và ném lỗi nói rõ', async () => {
  const f = fake((cmd) => (cmd === 'get-state' ? new Error('device not found') : new Error('?')));
  await assert.rejects(
    ensureEmulator({ ...base, bootTimeoutSec: 10, deps: f.deps }),
    (e: Error) => /emulator-5554/.test(e.message) && /Pixel_8_API_34/.test(e.message) && /10s/.test(e.message),
  );
  assert.equal(f.spawned.length, 1);
  assert.equal(f.killed.n, 1);
  assert.ok(f.calls.some((c) => c.slice(2).join(' ') === 'emu kill'));
});

test('ensureEmulator: emulator thoát sớm với mã lỗi thì báo ngay, không chờ hết hạn', async () => {
  const f = fake((cmd) => (cmd === 'get-state' ? new Error('device not found') : new Error('?')), () => 1);
  await assert.rejects(ensureEmulator({ ...base, deps: f.deps }), /thoát sớm với mã 1/);
  assert.ok(f.clock.t < 5000);
});

test('ensureEmulator: từ chối serial/AVD không hợp lệ trước khi chạy gì', async () => {
  const f = fake(() => new Error('không được gọi'));
  await assert.rejects(ensureEmulator({ ...base, serial: 'emulator-5555', deps: f.deps }), /5554..5584/);
  await assert.rejects(ensureEmulator({ ...base, avd: '-wipe-data', deps: f.deps }), /AVD/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawned.length, 0);
});

test('killEmulator: adb -s <serial> emu kill', async () => {
  const f = fake(() => '');
  await killEmulator('/x/adb', 'emulator-5556', f.deps);
  assert.deepEqual(f.calls, [['-s', 'emulator-5556', 'emu', 'kill']]);
});

test('startEmulators: bật song song, chỉ tắt máy do mình bật, một máy lỗi thì dừng toàn bộ', async () => {
  const emulators = {
    autoStart: true,
    avds: { 'emulator-5554': 'A', 'emulator-5556': 'B' },
    headless: false,
    bootTimeoutSec: 20,
    closeWhenDone: true,
    readOnly: false,
  };
  const up = new Set<string>(['emulator-5554']); // 5554 người dùng tự bật
  const killedSerials: string[] = [];
  const spawnedPorts: string[] = [];
  const clock = { t: 0 };
  const deps: EmulatorDeps = {
    exec: async (_f, args) => {
      const serial = args[1];
      const cmd = args.slice(2).join(' ');
      if (cmd === 'emu kill') {
        killedSerials.push(serial);
        return 'OK';
      }
      if (cmd === 'get-state') {
        if (!up.has(serial)) throw new Error('device not found');
        return 'device';
      }
      if (cmd === 'emu avd name') return 'A\nOK';
      if (cmd.startsWith('shell getprop')) return '1';
      return 'package:/x';
    },
    spawn: (_f, args) => {
      spawnedPorts.push(args[3]);
      setTimeout(() => up.add('emulator-' + args[3]), 0);
      return { exitCode: () => null, kill: () => {} };
    },
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise((r) => setTimeout(r, 1));
    },
    now: () => clock.t,
  };
  const logs: string[] = [];
  const s = await startEmulators({ emulators, adbPath: 'adb', emulatorPath: 'emu', deps, log: (m) => logs.push(m) });
  assert.deepEqual(spawnedPorts, ['5556']);
  assert.deepEqual(s.started, ['emulator-5556']);
  assert.ok(logs.some((l) => /emulator-5556 \(B\) xong sau \d+s/.test(l)));
  await s.closeStarted();
  assert.deepEqual(killedSerials, ['emulator-5556']);

  // máy lỗi: báo đúng máy
  const failDeps: EmulatorDeps = { ...deps, exec: async (_f, args) => {
    if (args[1] === 'emulator-5556' && args.slice(2).join(' ') === 'get-state') throw new Error('device not found');
    return deps.exec(_f, args, 1);
  }, spawn: () => ({ exitCode: () => 1, kill: () => {} }) };
  up.clear();
  await assert.rejects(
    startEmulators({ emulators: { ...emulators, avds: { 'emulator-5556': 'B' } }, adbPath: 'adb', emulatorPath: 'emu', deps: failDeps }),
    /emulator-5556.*thoát sớm/s,
  );
});
