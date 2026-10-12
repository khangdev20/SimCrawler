import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';

export interface FindAdbResult {
  path: string;
  source: string;
}

export interface FindAdbOptions {
  userPath?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  home?: string;
  platform?: NodeJS.Platform;
}

export function findAdb(opts: FindAdbOptions = {}): FindAdbResult | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const pJoin = platform === 'win32' ? win32.join : join;
  const bin = platform === 'win32' ? 'adb.exe' : 'adb';

  // 1. Giá trị người dùng nhập
  if (opts.userPath && opts.userPath.trim()) {
    const u = opts.userPath.trim();
    if (exists(u)) return { path: u, source: 'user' };
  }

  // 2. env ADB_PATH
  if (env.ADB_PATH && env.ADB_PATH.trim()) {
    const a = env.ADB_PATH.trim();
    if (exists(a)) return { path: a, source: 'ADB_PATH' };
  }

  // 3. $ANDROID_HOME và $ANDROID_SDK_ROOT + /platform-tools/adb
  if (env.ANDROID_HOME && env.ANDROID_HOME.trim()) {
    const p = join(env.ANDROID_HOME.trim(), 'platform-tools', bin);
    if (exists(p)) return { path: p, source: 'ANDROID_HOME' };
  }
  if (env.ANDROID_SDK_ROOT && env.ANDROID_SDK_ROOT.trim()) {
    const p = join(env.ANDROID_SDK_ROOT.trim(), 'platform-tools', bin);
    if (exists(p)) return { path: p, source: 'ANDROID_SDK_ROOT' };
  }

  // 4. ~/Library/Android/sdk/platform-tools/adb
  const macSdk = join(home, 'Library', 'Android', 'sdk', 'platform-tools', bin);
  if (exists(macSdk)) return { path: macSdk, source: 'macos_sdk' };

  // 5. ~/Android/Sdk/platform-tools/adb
  const linuxSdk = join(home, 'Android', 'Sdk', 'platform-tools', bin);
  if (exists(linuxSdk)) return { path: linuxSdk, source: 'android_sdk' };

  // 6. Windows: %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
  const localAppData = env.LOCALAPPDATA;
  const winSdk = localAppData
    ? pJoin(localAppData, 'Android', 'Sdk', 'platform-tools', bin)
    : pJoin(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', bin);
  if (platform === 'win32' && exists(winSdk)) return { path: winSdk, source: 'windows_sdk' };

  // 6. /opt/homebrew/bin/adb
  const homebrew = join('/opt', 'homebrew', 'bin', bin);
  if (exists(homebrew)) return { path: homebrew, source: 'homebrew' };

  // 7. /usr/local/bin/adb
  const usrLocal = join('/usr', 'local', 'bin', bin);
  if (exists(usrLocal)) return { path: usrLocal, source: 'usr_local' };

  // 8. cuối cùng là 'adb' trong PATH
  const sep = platform === 'win32' ? ';' : ':';
  const pathDirs = (env.PATH ?? '').split(sep).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = pJoin(dir, bin);
    if (exists(candidate)) {
      return { path: 'adb', source: 'path' };
    }
  }
  if (exists(bin)) {
    return { path: 'adb', source: 'path' };
  }

  return null;
}
