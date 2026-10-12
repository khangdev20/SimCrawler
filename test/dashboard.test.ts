import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Board } from '../src/board.js';
import { startDashboard } from '../src/dashboard.js';
import { encodePng } from '../src/png.js';
import type { Stats } from '../src/types.js';

const STATS: Stats = { steps: 3, uniqueScreens: 2, crashes: 1, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 };

function get(url: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }),
        );
      })
      .on('error', reject);
  });
}

test('dashboard: trang, state, ảnh, SSE, và chỉ nhận Host localhost', async () => {
  const board = new Board();
  board.meta.package = 'com.fake.app';
  board.register('emulator-5554');
  board.register('emulator-5556');
  const dash = await startDashboard(board, 0);
  try {
    assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await get(dash.url + '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body.toString(), /SimCrawler/);

    // chưa có ảnh -> 404
    assert.equal((await get(dash.url + '/shot/0')).status, 404);
    assert.equal((await get(dash.url + '/shot/99')).status, 404);
    assert.equal((await get(dash.url + '/shot/../../etc/passwd')).status, 404);

    // mở SSE rồi đẩy một cập nhật
    const received = new Promise<any>((resolve, reject) => {
      const req = http.get(dash.url + '/events', (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c: string) => {
          buf += c;
          const m = /data: (.*)\n\n/.exec(buf);
          if (m) {
            resolve(JSON.parse(m[1]));
            req.destroy();
          }
        });
      });
      req.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
      });
      setTimeout(() => reject(new Error('SSE không nhận được cập nhật')), 3000).unref();
    });
    await new Promise((r) => setTimeout(r, 100)); // chờ client đăng ký
    const png = encodePng(2, 2, Buffer.alloc(12, 200));
    board.push('emulator-5556', {
      stats: STATS,
      shot: png,
      screen: { w: 360, h: 800 },
      marker: { x: 180, y: 400 },
      line: { t: '01:00:00', step: 3, kind: 'event', text: 'crash: boom', event: 'crash' },
    });
    const u = await received;
    assert.equal(u.index, 1);
    assert.equal(u.serial, 'emulator-5556');
    assert.deepEqual(u.marker, { x: 0.5, y: 0.5 });
    assert.equal(u.stats.crashes, 1);
    assert.equal(u.line.event, 'crash');

    const shot = await get(dash.url + '/shot/1');
    assert.equal(shot.status, 200);
    assert.equal(shot.type, 'image/png');
    assert.deepEqual(shot.body, png);

    const state = JSON.parse((await get(dash.url + '/state')).body.toString());
    assert.equal(state.package, 'com.fake.app');
    assert.equal(state.devices.length, 2);
    assert.equal(state.devices[1].lines.length, 1);

    // DNS rebinding: Host lạ bị từ chối
    assert.equal((await get(dash.url + '/state', { host: 'evil.example.com' })).status, 403);
  } finally {
    await dash.close();
  }
});
