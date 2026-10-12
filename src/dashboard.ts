import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Board } from './board.js';

export interface DashboardHandle {
  url: string;
  close(): Promise<void>;
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0 && attempt < 10) {
          attempt++;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(p, host, () => {
        server.off('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryPort(port);
  });
}

/**
 * Trang xem trực tiếp, chỉ đọc. Chỉ bind 127.0.0.1 và từ chối Host lạ
 * (chống DNS rebinding), vì ảnh màn hình thiết bị có thể chứa dữ liệu nhạy cảm.
 */
export async function startDashboard(board: Board, port: number): Promise<DashboardHandle> {
  const page = readFileSync(new URL('./page.html', import.meta.url));
  const clients = new Set<http.ServerResponse>();

  const onUpdate = (payload: unknown) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(data);
  };
  board.on('update', onUpdate);

  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 20_000);
  ping.unref();

  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(board.snapshot()));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const m = /^\/shot\/(\d+)$/.exec(url.pathname);
    if (m) {
      const d = board.devices[Number(m[1])];
      if (!d || !d.shot) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(d.shot);
      return;
    }
    res.writeHead(404).end();
  });

  const actualPort = await listen(server, port, '127.0.0.1');

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(ping);
        board.off('update', onUpdate);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
