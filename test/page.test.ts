import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

/**
 * Chạy script của page.html trong một DOM giả tối thiểu để bắt lỗi chạy thật
 * (gõ nhầm tên biến, gọi sai API...). Không thay thế việc nhìn trang trong trình duyệt.
 */
class El {
  children: El[] = [];
  parent: El | null = null;
  className = '';
  style: Record<string, string> = {};
  src = '';
  alt = '';
  offsetWidth = 0;
  value = '';
  type = '';
  checked = false;
  disabled = false;
  onclick?: () => void;
  onchange?: () => void;
  oninput?: () => void;
  private text = '';
  classList = {
    add: (c: string) => {
      if (!this.className.split(' ').includes(c)) this.className = (this.className + ' ' + c).trim();
    },
    remove: (c: string) => {
      this.className = this.className.split(' ').filter((x) => x !== c).join(' ');
    },
  };
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this.text;
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null) {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: El) {
    this.children.splice(this.children.indexOf(c), 1);
    return c;
  }
}

test('page.html: dựng thẻ thiết bị từ /state và cập nhật theo SSE', async () => {
  const html = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];

  const byId: Record<string, El> = { main: new El('main'), pkg: new El('span'), conn: new El('span') };
  const sources: { url?: string; onopen?: () => void; onerror?: () => void; onmessage?: (e: { data: string }) => void }[] = [];
  const state = {
    package: 'com.fake.app',
    devices: [
      { index: 0, serial: 'emulator-5554', status: 'running', stopReason: '', shotSeq: 0, marker: null,
        stats: { steps: 1, uniqueScreens: 1, crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 },
        lines: [{ t: '01:00:00', step: 1, kind: 'step', text: 'tap btn_a "A"' }] },
      { index: 1, serial: 'emulator-5556', status: 'waiting', stopReason: '', shotSeq: 0, marker: null,
        stats: { steps: 0, uniqueScreens: 0, crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 },
        lines: [] },
    ],
  };

  const ctx = {
    document: {
      getElementById: (id: string) => byId[id] || (byId[id] = new El(id)),
      createElement: (tag: string) => new El(tag),
      createTextNode: (t: string) => {
        const e = new El('#text');
        e.textContent = t;
        return e;
      },
    },
    fetch: async () => ({ json: async () => state }),
    EventSource: class {
      onopen?: () => void;
      onerror?: () => void;
      onmessage?: (e: { data: string }) => void;
      constructor(readonly url: string) {
        sources.push(this);
      }
    },
  };
  vm.runInNewContext(script, ctx);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(byId.pkg.textContent, 'com.fake.app');
  const cards = byId.main.children;
  assert.equal(cards.length, 2);
  const [head0, stats0, body0] = cards[0].children;
  assert.equal(head0.children[0].textContent, 'emulator-5554');
  assert.equal(head0.children[1].textContent, 'đang chạy');
  assert.match(stats0.textContent, /1 bước/);
  assert.equal(body0.children[1].children.length, 1); // 1 dòng log từ snapshot
  assert.equal(cards[1].children[0].children[1].textContent, 'chờ');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, '/events');

  // cập nhật SSE: crash trên máy 2, có ảnh và điểm chạm
  const update = (u: object) => sources[0].onmessage!({ data: JSON.stringify(u) });
  update({
    index: 1, serial: 'emulator-5556', status: 'running', stopReason: '', shotSeq: 3,
    marker: { x: 0.5, y: 0.25 },
    stats: { steps: 3, uniqueScreens: 2, crashes: 1, anrs: 0, relaunches: 1, stuck: 0, leftApp: 0, errors: 0 },
    line: { t: '01:00:03', step: 3, kind: 'event', text: 'crash: boom', event: 'crash' },
  });
  const [head1, stats1, body1] = cards[1].children;
  const [shot, log] = body1.children;
  const [empty, img, mark] = shot.children;
  assert.equal(head1.children[1].textContent, 'đang chạy');
  assert.match(stats1.textContent, /1 crash/);
  assert.equal(stats1.children[2].className, 'bad'); // crash > 0 được tô đỏ
  assert.equal(img.src, '/shot/1?v=3');
  assert.equal(img.style.display, 'block');
  assert.equal(empty.style.display, 'none');
  assert.deepEqual([mark.style.left, mark.style.top, mark.style.display], ['50%', '25%', 'block']);
  assert.ok(mark.className.includes('ping'));
  assert.equal(log.children.length, 1);
  assert.equal(log.children[0].className, 'crash');

  // dòng mới nằm trên cùng, và trạng thái kết thúc hiển thị lý do bằng tiếng Việt
  update({
    index: 1, serial: 'emulator-5556', status: 'done', stopReason: 'saturated', shotSeq: 3, marker: null,
    stats: { steps: 4, uniqueScreens: 2, crashes: 1, anrs: 0, relaunches: 1, stuck: 1, leftApp: 0, errors: 0 },
    line: { t: '01:00:04', step: 4, kind: 'event', text: 'stuck: x', event: 'stuck' },
  });
  assert.equal(log.children[0].className, 'stuck');
  assert.equal(log.children[1].className, 'crash');
  assert.equal(head1.children[1].textContent, 'xong · hết thứ để thử');
  assert.equal(img.src, '/shot/1?v=3'); // shotSeq không đổi thì không tải lại ảnh
});

test('page.html: chế độ app với window.simcrawler, controls, start, blob url và summary', async () => {
  const html = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];

  const byId: Record<string, El> = {
    main: new El('main'),
    pkg: new El('span'),
    conn: new El('span'),
    'app-controls': new El('div'),
    'error-banner': new El('div'),
    'summary-panel': new El('div'),
    'btn-start': new El('button'),
    'btn-stop': new El('button'),
    'btn-refresh': new El('button'),
    'btn-logs': new El('button'),
    'input-pkg': new El('input'),
    'input-minutes': new El('input'),
    'input-blacklist': new El('input'),
    'input-adb': new El('input'),
    'device-list': new El('div'),
    'pkg-list': new El('datalist'),
    'adb-info': new El('span'),
  };

  let startedConfig: any = null;
  let onStartedCallback: any = null;
  let onUpdateCallback: any = null;
  let onFinishedCallback: any = null;
  let blobSeq = 0;
  const revokedUrls: string[] = [];

  const simcrawler = {
    getInitial: async () => ({
      settings: {
        package: 'com.fake.app',
        devices: ['fake-1'],
        maxMinutes: 5,
        blacklist: ['logout', 'delete'],
      },
      adb: { path: '/opt/homebrew/bin/adb', source: 'homebrew' },
    }),
    listDevices: async () => [
      { serial: 'fake-1', state: 'device', model: 'Pixel_6' },
      { serial: 'fake-2', state: 'offline' },
    ],
    listPackages: async (_serial: string) => ['com.fake.app', 'com.other.app'],
    start: async (cfg: any) => {
      startedConfig = cfg;
      return { ok: true };
    },
    stop: async () => ({ ok: true }),
    getState: async () => ({ package: '', devices: [] }),
    getShot: async (_idx: number) => Buffer.from('png-bytes'),
    openLogs: async () => ({ ok: true }),
    onStarted: (cb: any) => {
      onStartedCallback = cb;
      return () => {};
    },
    onUpdate: (cb: any) => {
      onUpdateCallback = cb;
      return () => {};
    },
    onFinished: (cb: any) => {
      onFinishedCallback = cb;
      return () => {};
    },
  };

  class FakeBlob {
    constructor(readonly parts: any[], readonly opts?: any) {}
  }

  const FakeURL = {
    createObjectURL: (_blob: any) => `blob:test-${++blobSeq}`,
    revokeObjectURL: (url: string) => {
      revokedUrls.push(url);
    },
  };

  const windowObj: any = {
    simcrawler,
    Blob: FakeBlob,
    URL: FakeURL,
  };

  const ctx = {
    window: windowObj,
    document: {
      getElementById: (id: string) => byId[id] || (byId[id] = new El(id)),
      createElement: (tag: string) => new El(tag),
      createTextNode: (t: string) => {
        const e = new El('#text');
        e.textContent = t;
        return e;
      },
    },
    Blob: FakeBlob,
    URL: FakeURL,
    Set,
  };

  vm.runInNewContext(script, ctx);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Kiểm tra app-controls hiển thị và dữ liệu cấu hình đã nạp
  assert.equal(byId['app-controls'].style.display, 'flex');
  assert.equal(byId['input-pkg'].value, 'com.fake.app');
  assert.equal(byId['input-minutes'].value, 5);
  assert.equal(byId['input-blacklist'].value, 'logout, delete');
  assert.match(byId['adb-info'].textContent, /\/opt\/homebrew\/bin\/adb/);

  // Danh sách thiết bị: fake-1 được chọn, fake-2 không
  const devItems = byId['device-list'].children;
  assert.equal(devItems.length, 2);
  const cb1 = devItems[0].children[0];
  const cb2 = devItems[1].children[0];
  assert.equal(cb1.checked, true);
  assert.equal(cb2.checked, false);
  assert.equal(byId['btn-start'].disabled, false);

  // Bấm Start -> gọi window.simcrawler.start với đúng dữ liệu
  byId['btn-start'].onclick!();
  assert.ok(startedConfig);
  assert.equal(startedConfig.package, 'com.fake.app');
  assert.deepEqual([...startedConfig.devices], ['fake-1']);
  assert.equal(startedConfig.maxMinutes, 5);
  assert.deepEqual([...startedConfig.blacklist], ['logout', 'delete']);

  // Sự kiện run:started dựng lại thẻ thiết bị
  onStartedCallback({
    package: 'com.fake.app',
    devices: [
      {
        index: 0,
        serial: 'fake-1',
        status: 'running',
        stopReason: '',
        shotSeq: 0,
        marker: null,
        stats: { steps: 0, uniqueScreens: 0, crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 },
        lines: [],
      },
    ],
  });

  const cards = byId.main.children;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].children[0].children[0].textContent, 'fake-1');
  assert.equal(byId['countdown'].style.display, 'inline-block');
  assert.equal(byId['countdown'].textContent, '⏱️ 05:00');

  // Sự kiện run:update tải ảnh qua Blob URL
  onUpdateCallback({
    index: 0,
    serial: 'fake-1',
    status: 'running',
    stopReason: '',
    shotSeq: 1,
    marker: { x: 0.5, y: 0.5 },
    stats: { steps: 1, uniqueScreens: 1, crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 },
    line: { t: '01:00:01', step: 1, kind: 'step', text: 'tap btn_ok "OK"' },
  });
  await new Promise((r) => setImmediate(r));

  const img = cards[0].children[2].children[0].children[1];
  assert.match(img.src, /^blob:test-/);

  // Cập nhật ảnh tiếp theo: ảnh cũ bị revoke
  const prevBlob = img.src;
  onUpdateCallback({
    index: 0,
    serial: 'fake-1',
    status: 'running',
    stopReason: '',
    shotSeq: 2,
    marker: null,
    stats: { steps: 2, uniqueScreens: 1, crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 },
    line: { t: '01:00:02', step: 2, kind: 'step', text: 'tap btn_next "Next"' },
  });
  await new Promise((r) => setImmediate(r));
  assert.notEqual(img.src, prevBlob);
  assert.ok(revokedUrls.includes(prevBlob));

  // Sự kiện run:finished hiện bảng tóm tắt
  onFinishedCallback({
    ok: true,
    summary: {
      package: 'com.fake.app',
      devices: [
        {
          serial: 'fake-1',
          steps: 42,
          uniqueScreens: 6,
          crashes: 1,
          anrs: 0,
          relaunches: 2,
          stopReason: 'saturated',
          untriedElements: 3,
        },
      ],
    },
  });

  assert.equal(byId['summary-panel'].style.display, 'block');
  assert.equal(byId['countdown'].style.display, 'none');
  assert.match(byId['summary-panel'].textContent, /fake-1: 42 bước/);
  assert.match(byId['summary-panel'].textContent, /1 crash/);
  assert.match(byId['summary-panel'].textContent, /hết thứ để thử/);
  assert.match(byId['summary-panel'].textContent, /còn 3 phần tử chưa thử/);
});

test('page.html: giới hạn số lượng thiết bị được chọn khi fetch devices và cập nhật qua ô nhập', async () => {
  const html = readFileSync(new URL('../src/page.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];

  const byId: Record<string, El> = {};
  const get = (id: string) => byId[id] || (byId[id] = new El(id));
  let startedConfig: any = null;

  const simcrawler = {
    getInitial: async () => ({
      settings: { package: 'com.test.app', deviceCount: 2 },
    }),
    listDevices: async () => [
      { serial: 'dev-1', state: 'device' },
      { serial: 'dev-2', state: 'device' },
      { serial: 'dev-3', state: 'device' },
      { serial: 'dev-4', state: 'offline' },
    ],
    listPackages: async () => ['com.test.app'],
    start: async (cfg: any) => {
      startedConfig = cfg;
      return { ok: true };
    },
    stop: async () => ({ ok: true }),
    getState: async () => ({ package: '', devices: [] }),
    getShot: async () => null,
    openLogs: async () => ({ ok: true }),
    onStarted: () => () => {},
    onUpdate: () => () => {},
    onFinished: () => () => {},
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

  // Ban đầu deviceCount = 2, chỉ dev-1 và dev-2 được tick
  const devItems = get('device-list').children;
  assert.equal(devItems.length, 4);
  assert.equal(devItems[0].children[0].checked, true);
  assert.equal(devItems[1].children[0].checked, true);
  assert.equal(devItems[2].children[0].checked, false);
  assert.equal(devItems[3].children[0].checked, false);
  assert.equal(get('dev-selected-badge').textContent, '(2 máy)');

  // Đổi số lượng thiết bị thành 1 -> tự động chỉ tick máy đầu tiên
  get('input-dev-count').value = '1';
  get('input-dev-count').oninput!();
  assert.equal(devItems[0].children[0].checked, true);
  assert.equal(devItems[1].children[0].checked, false);
  assert.equal(devItems[2].children[0].checked, false);
  assert.equal(get('dev-selected-badge').textContent, '(1 máy)');

  // Bấm start gửi đúng 1 máy và deviceCount = 1
  get('btn-start').onclick!();
  assert.ok(startedConfig);
  assert.deepEqual([...startedConfig.devices], ['dev-1']);
  assert.equal(startedConfig.deviceCount, 1);
});
