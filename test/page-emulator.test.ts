import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class El {
  children: El[] = [];
  className = '';
  style: Record<string, string> = {};
  value: any = '';
  checked = false;
  disabled = false;
  onclick?: () => void;
  onchange?: () => void;
  oninput?: () => void;
  textContent = '';
  constructor(readonly tag: string) {}
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
}

test('page.html: công tắc "Tự khởi động emulator" và chọn AVD gửi emulators + serial chưa bật khi Start', async () => {
  const html = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const byId: Record<string, El> = {};
  const get = (id: string) => byId[id] || (byId[id] = new El(id));
  let started: any = null;
  const simcrawler = {
    getInitial: async () => ({ settings: { package: 'com.fake.app' } }),
    listDevices: async () => [], // emulator đang tắt nên adb không thấy
    listPackages: async () => [],
    listAvds: async () => ['Pixel_9', 'Pixel_10'],
    start: async (cfg: any) => {
      started = cfg;
      return { ok: true };
    },
    stop: async () => ({}),
    getState: async () => ({ package: '', devices: [] }),
    getShot: async () => null,
    openLogs: async () => ({}),
    onStarted: () => () => {},
    onUpdate: () => () => {},
    onFinished: () => () => {},
    onStatus: () => () => {},
  };
  const ctx = {
    window: { simcrawler, Blob: class {}, URL: {} },
    document: {
      getElementById: get,
      createElement: (t: string) => new El(t),
      createTextNode: (t: string) => Object.assign(new El('#text'), { textContent: t }),
    },
    Set,
  };
  vm.runInNewContext(script, ctx);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));

  // tắt công tắc: danh sách AVD ẩn, không có thiết bị thì Start bị khóa
  assert.equal(get('avd-list').style.display, 'none');
  assert.equal(get('btn-start').disabled, true);

  // bật công tắc: mỗi emulator một ô chọn, liệt kê AVD của máy
  get('chk-emu').checked = true;
  get('chk-emu').onchange!();
  assert.equal(get('avd-list').style.display, 'flex');
  const rows = get('avd-list').children;
  assert.equal(rows.length, 2);
  const select = rows[0].children[1];
  assert.deepEqual(select.children.map((o) => o.value), ['', 'Pixel_9', 'Pixel_10']);

  // chọn AVD cho emulator-5554: máy này được thêm vào devices dù chưa bật
  select.value = 'Pixel_9';
  select.onchange!();
  assert.equal(get('input-pkg').value, 'com.fake.app'); // nạp từ settings
  assert.equal(get('btn-start').disabled, false);
  get('btn-start').onclick!();
  assert.deepEqual([...started.devices], ['emulator-5554']);
  assert.deepEqual(started.emulators.autoStart, true);
  assert.deepEqual({ ...started.emulators.avds }, { 'emulator-5554': 'Pixel_9' });
});
