import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config.js';
import { summarizeCrash } from '../src/crash.js';
import { encodePng, pngSize } from '../src/png.js';
import {
  detectSystemDialog,
  extractXml,
  parseActivity,
  parseHierarchy,
  pickAction,
  screenSignature,
} from '../src/ui.js';

const PKG = 'com.x.app';
const SCREEN = { w: 1080, h: 2400 };

const attrs = (o: {
  text?: string;
  id?: string;
  cls?: string;
  pkg?: string;
  clickable?: boolean;
  scrollable?: boolean;
  password?: boolean;
  enabled?: boolean;
  bounds: string;
}) =>
  `text="${o.text ?? ''}" resource-id="${o.id ?? ''}" class="${o.cls ?? 'android.view.View'}" package="${o.pkg ?? PKG}" ` +
  `content-desc="" clickable="${o.clickable ?? false}" enabled="${o.enabled ?? true}" scrollable="${o.scrollable ?? false}" ` +
  `password="${o.password ?? false}" bounds="${o.bounds}"`;

const SAMPLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
<node index="0" ${attrs({ bounds: '[0,0][1080,2400]' })}>
  <node index="0" ${attrs({ id: `${PKG}:id/row_logout`, cls: 'android.widget.LinearLayout', clickable: true, bounds: '[0,200][1080,400]' })}>
    <node index="0" ${attrs({ text: 'Log out &amp; leave', cls: 'android.widget.TextView', bounds: '[40,240][500,360]' })} />
  </node>
  <node index="1" ${attrs({ id: `${PKG}:id/btn_ok`, text: 'OK &quot;now&quot;', cls: 'android.widget.Button', clickable: true, bounds: '[0,500][1080,700]' })} />
  <node index="2" ${attrs({ id: `${PKG}:id/et_mail`, cls: 'android.widget.EditText', clickable: true, bounds: '[0,800][1080,900]' })} />
  <node index="3" ${attrs({ id: `${PKG}:id/pw`, cls: 'android.widget.EditText', clickable: true, password: true, bounds: '[0,950][1080,1050]' })} />
  <node index="4" ${attrs({ id: `${PKG}:id/list`, cls: 'androidx.recyclerview.widget.RecyclerView', scrollable: true, bounds: '[0,1100][1080,2300]' })} />
</node>
<node index="1" ${attrs({ pkg: 'com.android.systemui', id: 'com.android.systemui:id/clock', text: '12:00', clickable: true, bounds: '[0,0][1080,80]' })} />
</hierarchy>
UI hierarchy dumped to: /dev/tty`;

test('extractXml cắt dòng thừa và từ chối output hỏng', () => {
  const xml = extractXml(SAMPLE);
  assert.ok(xml?.startsWith('<hierarchy'));
  assert.ok(xml?.endsWith('</hierarchy>'));
  assert.equal(extractXml('ERROR: could not get idle state.'), null);
});

test('parseHierarchy: lồng nhau, self-closing, entity, chữ của node con', () => {
  const nodes = parseHierarchy(extractXml(SAMPLE)!);
  assert.equal(nodes.length, 8);
  const row = nodes.find((n) => n.resourceId.endsWith('row_logout'))!;
  assert.equal(row.text, '');
  assert.match(row.inner, /Log out & leave/);
  const ok = nodes.find((n) => n.resourceId.endsWith('btn_ok'))!;
  assert.equal(ok.text, 'OK "now"');
  assert.deepEqual([ok.cx, ok.cy, ok.w, ok.h], [540, 600, 1080, 200]);
  // node cha không nhận chữ của anh em
  assert.equal(nodes.find((n) => n.resourceId.endsWith('btn_ok'))!.inner, '');
});

test('pickAction: ưu tiên ô nhập, bỏ qua password và blacklist (kể cả chữ nằm ở node con)', () => {
  const nodes = parseHierarchy(extractXml(SAMPLE)!);
  const tried = new Set<string>();
  const base = { nodes, pkg: PKG, screen: SCREEN, tried, blacklist: ['log out', 'pay'], rng: () => 0 };

  const first = pickAction(base);
  assert.equal(first.action.type, 'type');
  assert.equal(first.action.type === 'type' && first.action.text, 'test@example.com');
  assert.deepEqual(first.skipped.map((s) => s.id), [`${PKG}:id/row_logout`]);
  tried.add(first.key!);

  const second = pickAction(base);
  assert.equal(second.action.type, 'tap');
  assert.equal(second.action.type === 'tap' && second.action.id, `${PKG}:id/btn_ok`);
  tried.add(second.key!);

  // hết phần tử bấm: vuốt danh sách tối đa 3 lần, rồi BACK
  const kinds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = pickAction(base);
    kinds.push(p.action.type);
    if (p.key) tried.add(p.key);
  }
  assert.deepEqual(kinds, ['swipe', 'swipe', 'swipe', 'back', 'back']);
});

test('pickAction: không bao giờ chọn node của package khác (systemui)', () => {
  const nodes = parseHierarchy(extractXml(SAMPLE)!);
  const tried = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const p = pickAction({ nodes, pkg: PKG, screen: SCREEN, tried, blacklist: [], rng: Math.random });
    if (p.action.type === 'tap') assert.notEqual(p.action.id, 'com.android.systemui:id/clock');
    if (p.key) tried.add(p.key);
  }
});

test('screenSignature: bỏ qua text, nhạy với cấu trúc và activity', () => {
  const a = parseHierarchy(extractXml(SAMPLE)!);
  const b = parseHierarchy(extractXml(SAMPLE.replace('OK &quot;now&quot;', 'Khác hẳn').replace('12:00', '12:01'))!);
  const c = parseHierarchy(extractXml(SAMPLE.replace('btn_ok', 'btn_other'))!);
  assert.equal(screenSignature('Main', a, PKG), screenSignature('Main', b, PKG));
  assert.notEqual(screenSignature('Main', a, PKG), screenSignature('Main', c, PKG));
  assert.notEqual(screenSignature('Main', a, PKG), screenSignature('Other', a, PKG));
});

test('detectSystemDialog: quyền, crash, ANR', () => {
  const perm = parseHierarchy(`<hierarchy>
    <node ${attrs({ pkg: 'com.google.android.permissioncontroller', id: 'com.android.permissioncontroller:id/permission_allow_one_time_button', text: 'Only this time', clickable: true, bounds: '[0,0][100,100]' })} />
    <node ${attrs({ pkg: 'com.google.android.permissioncontroller', id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button', text: 'While using the app', clickable: true, bounds: '[0,100][100,200]' })} />
  </hierarchy>`);
  const p = detectSystemDialog(perm);
  assert.equal(p?.kind, 'permission');
  assert.equal(p?.kind === 'permission' && p.button.text, 'While using the app');

  const crash = parseHierarchy(`<hierarchy>
    <node ${attrs({ pkg: 'android', id: 'android:id/alertTitle', text: 'Fake keeps stopping', bounds: '[0,0][100,50]' })} />
    <node ${attrs({ pkg: 'android', id: 'android:id/aerr_close', text: 'Close app', clickable: true, bounds: '[0,50][100,100]' })} />
  </hierarchy>`);
  const c = detectSystemDialog(crash);
  assert.ok(c?.kind === 'crash' && !c.anr && c.button?.text === 'Close app');

  const anr = parseHierarchy(`<hierarchy>
    <node ${attrs({ pkg: 'android', text: "Fake isn't responding", bounds: '[0,0][100,50]' })} />
    <node ${attrs({ pkg: 'android', id: 'android:id/aerr_wait', text: 'Wait', clickable: true, bounds: '[0,50][100,100]' })} />
    <node ${attrs({ pkg: 'android', id: 'android:id/aerr_close', text: 'Close app', clickable: true, bounds: '[0,100][100,150]' })} />
  </hierarchy>`);
  const a = detectSystemDialog(anr);
  assert.ok(a?.kind === 'crash' && a.anr && a.button?.text === 'Close app');

  assert.equal(detectSystemDialog(parseHierarchy(extractXml(SAMPLE)!)), null);
});

test('parseActivity', () => {
  assert.equal(parseActivity('mCurrentFocus=Window{1a u0 com.x.app/com.x.app.ui.MainActivity}'), 'ui.MainActivity');
  assert.equal(parseActivity('mCurrentFocus=Window{1a u0 com.x.app/.MainActivity}'), 'MainActivity');
  assert.equal(parseActivity('mCurrentFocus=null'), '');
});

test('summarizeCrash', () => {
  assert.equal(
    summarizeCrash('E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: java.lang.NullPointerException: x is null\n\tat a.b.C.d(C.kt:1)'),
    'java.lang.NullPointerException: x is null',
  );
  assert.match(summarizeCrash('F libc: Fatal signal 11 (SIGSEGV), code 1'), /signal 11 \(SIGSEGV\)/);
  assert.equal(summarizeCrash(''), '');
});

test('png: encode rồi đọc lại kích thước', () => {
  const png = encodePng(4, 3, Buffer.alloc(4 * 3 * 3, 128));
  assert.deepEqual(pngSize(png), { w: 4, h: 3 });
  assert.equal(pngSize(Buffer.from('not a png at all, definitely not')), null);
});

test('validateConfig: mặc định, và chặn package/serial có thể chèn lệnh shell', () => {
  const ok = validateConfig({ package: 'com.example.app', devices: ['emulator-5554', '192.168.1.5:5555'] }, '/tmp/x');
  assert.equal(ok.maxMinutes, 10);
  assert.equal(ok.stepDelayMs, 800);
  assert.equal(ok.outDir, '/tmp/x/logs');
  assert.throws(() => validateConfig({ package: 'com.x; rm -rf /', devices: ['a'] }, '/tmp'), /package/);
  assert.throws(() => validateConfig({ package: 'com.x.y', devices: ['a b'] }, '/tmp'), /devices/);
  assert.throws(() => validateConfig({ package: 'com.x.y', devices: ['a', 'a'] }, '/tmp'), /trùng/);
  assert.throws(() => validateConfig({ package: 'com.x.y', devices: ['a'], maxMinutes: 0 }, '/tmp'), /maxMinutes/);
});
