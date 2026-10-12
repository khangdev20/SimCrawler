import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

mkdirSync(resolve(root, 'dist'), { recursive: true });

copyFileSync(resolve(root, 'src/page.html'), resolve(root, 'dist/page.html'));

if (existsSync(resolve(root, 'build/icon.png'))) {
  copyFileSync(resolve(root, 'build/icon.png'), resolve(root, 'dist/icon.png'));
}

await esbuild.build({
  entryPoints: [resolve(root, 'app/main.ts')],
  outfile: resolve(root, 'dist/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});

await esbuild.build({
  entryPoints: [resolve(root, 'app/preload.ts')],
  outfile: resolve(root, 'dist/preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});

console.log('Build complete: dist/main.cjs, dist/preload.cjs, dist/page.html');
