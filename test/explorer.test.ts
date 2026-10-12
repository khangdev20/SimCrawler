import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.js';
import { Explorer } from '../src/explorer.js';
import { FakeDevice } from '../src/fake.js';
import { Recorder } from '../src/recorder.js';
import type { Config, StepRecord } from '../src/types.js';

const PKG = 'com.fake.app';

function config(seed: number, outDir: string): Config {
  return {
    package: PKG,
    devices: ['fake-1'],
    maxMinutes: 1,
    blacklist: ['logout', 'log out', 'delete', 'pay', 'purchase'],
    stepDelayMs: 0,
    launchWaitMs: 0,
    staleStepsBeforeRelaunch: 15,
    maxSteps: 0,
    dashboardPort: 0,
    seed,
    outDir,
  };
}

async function crawl(seed: number, mutate?: (c: Config) => void) {
  const out = mkdtempSync(join(tmpdir(), 'simcrawler-'));
  const cfg = config(seed, out);
  mutate?.(cfg);
  const dev = new FakeDevice('fake-1', PKG);
  const board = new Board();
  board.register('fake-1');
  const rec = new Recorder(out, 'fake-1', board);
  const summary = await new Explorer(dev, cfg, rec, { stopped: false }, 0).run(Date.now() + 60_000);
  const lines: StepRecord[] = readFileSync(join(out, 'fake-1.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { out, dev, board, summary, lines };
}

// Seed 3 từng bỏ sót About vì không đi lại được sau khi mở lại app; seed 4 và 5 từng bỏ sót About vì
// "stuck" mở lại app trước khi kịp quan sát kết quả của lần bấm cuối. Giữ lại làm test hồi quy.
for (const seed of [1, 2, 3, 4, 5]) {
  test(`khám phá app giả đến hết (seed ${seed})`, async () => {
    const { out, dev, board, summary, lines } = await crawl(seed);

    // Đi hết các màn hình của app: home, profile, settings, about, list, detail
    assert.equal(summary.uniqueScreens, 6, JSON.stringify(summary.screens));
    assert.equal(summary.stopReason, 'saturated');
    // "Hết thứ để thử" phải đúng nghĩa, và mọi dòng danh sách (kể cả phải cuộn mới thấy) đều được bấm
    assert.equal(summary.untriedElements, 0);
    const rows = new Set(
      lines.filter((l) => l.action.type === 'tap' && l.action.id.endsWith('item_row')).map((l) => l.action.type === 'tap' && l.action.label),
    );
    assert.equal(rows.size, 12);
    // Đã đi lại bằng đường đã biết thay vì BACK liên tục
    assert.ok(lines.some((l) => l.note?.startsWith('đi tới')));

    // Không bao giờ bấm nút nguy hiểm, và ghi lại rằng đã bỏ qua chúng
    assert.equal(dev.dangerTaps, 0);
    const skipped = summary.skippedByBlacklist.map((s) => s.id.split('/').pop()).sort();
    assert.deepEqual(skipped, ['btn_delete', 'btn_logout']);

    // Nút gây crash được bấm đúng một lần, và crash chỉ được đếm một lần dù có hộp thoại hệ thống
    assert.equal(dev.bugTaps, 1);
    assert.equal(summary.crashes, 1);
    const crash = lines.find((l) => l.event === 'crash')!;
    assert.match(crash.note ?? '', /IllegalStateException: Fake bug triggered/);
    assert.equal(crash.alive, false);
    assert.ok(crash.shot && existsSync(join(out, crash.shot)), 'ảnh trước crash');
    assert.ok(crash.shotAfter && existsSync(join(out, crash.shotAfter)), 'ảnh sau crash');
    assert.match(readFileSync(join(out, crash.crashLog!), 'utf8'), /FATAL EXCEPTION/);
    assert.ok(lines.some((l) => l.event === 'dialog_dismissed'), 'hộp thoại crash được đóng');

    // Hộp thoại quyền, link ra ngoài app, và mở lại app
    assert.ok(lines.some((l) => l.event === 'permission'));
    assert.ok(summary.leftApp >= 1 && lines.some((l) => l.event === 'left_app'));
    assert.ok(summary.relaunches >= 1);

    // Log: mỗi dòng là JSON hợp lệ, step không giảm, có đủ trường
    let prev = 0;
    for (const l of lines) {
      assert.equal(l.dev, 'fake-1');
      assert.ok(typeof l.t === 'string' && typeof l.sig === 'string' && l.action);
      assert.ok(l.step >= prev);
      prev = l.step;
    }
    assert.equal(lines.filter((l) => l.newScreen).length, 6);

    // Dashboard nhận ảnh và trạng thái cuối
    const d = board.devices[0];
    assert.equal(d.status, 'done');
    assert.equal(d.stopReason, 'saturated');
    assert.ok(d.shot && d.shotSeq > 10);
    assert.equal(d.stats.crashes, 1);

    assert.deepEqual(readdirSync(out).sort(), ['crashes', 'fake-1.jsonl', 'shots']);
  });
}

test('cùng seed thì đi cùng đường', async () => {
  const a = await crawl(7);
  const b = await crawl(7);
  const path = (ls: StepRecord[]) => ls.map((l) => `${l.step}:${l.event ?? ''}:${JSON.stringify(l.action)}`);
  assert.deepEqual(path(a.lines), path(b.lines));
});

test('dừng đúng ở maxSteps', async () => {
  const { summary } = await crawl(1, (c) => {
    c.maxSteps = 12;
  });
  assert.equal(summary.stopReason, 'steps');
  assert.equal(summary.steps, 12);
});

test('RunControl.stopped dừng ngay với lý do interrupted', async () => {
  const out = mkdtempSync(join(tmpdir(), 'simcrawler-'));
  const board = new Board();
  board.register('fake-1');
  const ctl = { stopped: true };
  const s = await new Explorer(new FakeDevice('fake-1', PKG), config(1, out), new Recorder(out, 'fake-1', board), ctl).run(
    Date.now() + 60_000,
  );
  assert.equal(s.stopReason, 'interrupted');
  assert.equal(s.steps, 0);
});
