import { encodePng } from './png.js';
import type { Device } from './types.js';

/**
 * Thiết bị giả dùng cho `--fake` (demo dashboard không cần emulator) và cho test.
 * Mô phỏng một app nhỏ: màn hình chính, hồ sơ (có ô nhập), cài đặt (có nút gây crash),
 * danh sách cuộn, chi tiết (có nút xóa), giới thiệu (có link mở trình duyệt),
 * hộp thoại quyền ở lần mở đầu và hộp thoại "keeps stopping" sau crash.
 */

const W = 360;
const H = 800;

type Rect = [number, number, number, number];
type Color = [number, number, number];

interface FNode {
  id?: string;
  text?: string;
  cls?: string;
  r: Rect;
  pkg?: string;
  clickable?: boolean;
  scrollable?: boolean;
  color?: Color;
  children?: FNode[];
  onTap?: () => void;
}

type ScreenName = 'launcher' | 'home' | 'profile' | 'settings' | 'about' | 'list' | 'detail' | 'web';

const ACTIVITY: Record<string, string> = {
  home: 'MainActivity',
  profile: 'ProfileActivity',
  settings: 'SettingsActivity',
  about: 'AboutActivity',
  list: 'ListActivity',
  detail: 'DetailActivity',
};
const PARENT: Partial<Record<ScreenName, ScreenName>> = {
  profile: 'home',
  settings: 'home',
  list: 'home',
  about: 'settings',
  detail: 'list',
  web: 'about',
};
const BG: Record<ScreenName, Color> = {
  launcher: [30, 40, 60],
  home: [24, 32, 44],
  profile: [34, 30, 48],
  settings: [28, 38, 36],
  about: [44, 34, 30],
  list: [26, 30, 40],
  detail: [40, 28, 38],
  web: [20, 20, 20],
};

const CRASH_LOG = `--------- beginning of crash
10-12 01:00:00.000  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main
10-12 01:00:00.000  4242  4242 E AndroidRuntime: Process: com.fake.app, PID: 4242
10-12 01:00:00.000  4242  4242 E AndroidRuntime: java.lang.IllegalStateException: Fake bug triggered
10-12 01:00:00.000  4242  4242 E AndroidRuntime: \tat com.fake.app.SettingsActivity.onBugClick(SettingsActivity.kt:42)
`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeDevice implements Device {
  screen: ScreenName = 'launcher';
  private pidNum = 0;
  private nextPid = 3000;
  private firstLaunch = true;
  private permPending = false;
  private crashDialog = false;
  private scroll = 0;
  private item = 0;
  private kbd = false;
  private crashText = '';
  private editFocused = false;

  /** Dùng trong test để kiểm tra hành vi của explorer */
  readonly tapLog: { x: number; y: number; hit: string }[] = [];
  dangerTaps = 0;
  bugTaps = 0;

  constructor(
    readonly serial: string,
    private readonly pkg: string,
  ) {}

  // ----------------------------------------------------------- screens

  private id(name: string): string {
    return `${this.pkg}:id/${name}`;
  }

  private btn(name: string, text: string, r: Rect, onTap: () => void): FNode {
    return { id: this.id(name), text, cls: 'android.widget.Button', r, clickable: true, onTap };
  }

  private go(s: ScreenName): void {
    // Quay từ chi tiết về danh sách thì giữ vị trí cuộn, như app Android thông thường.
    if (s === 'list' && this.screen !== 'detail') this.scroll = 0;
    this.screen = s;
    this.kbd = false;
    this.editFocused = false;
  }

  private crash(): void {
    this.pidNum = 0;
    this.screen = 'launcher';
    this.crashDialog = true;
    this.crashText = CRASH_LOG;
  }

  private appContent(): FNode[] {
    const t = (text: string, r: Rect): FNode => ({ text, cls: 'android.widget.TextView', r });
    switch (this.screen) {
      case 'home':
        return [
          t('Home', [20, 40, 340, 90]),
          this.btn('btn_profile', 'Profile', [40, 100, 320, 160], () => this.go('profile')),
          this.btn('btn_settings', 'Settings', [40, 180, 320, 240], () => this.go('settings')),
          this.btn('btn_list', 'Items', [40, 260, 320, 320], () => this.go('list')),
          {
            id: this.id('btn_logout'),
            cls: 'android.widget.LinearLayout',
            r: [40, 340, 320, 400],
            clickable: true,
            onTap: () => this.dangerTaps++,
            children: [{ text: 'Log out', cls: 'android.widget.TextView', r: [60, 350, 300, 390] }],
          },
        ];
      case 'profile':
        return [
          t('Profile', [20, 40, 340, 90]),
          {
            id: this.id('et_name'),
            cls: 'android.widget.EditText',
            r: [40, 100, 320, 160],
            clickable: true,
            onTap: () => {
              this.editFocused = true;
            },
          },
          this.btn('btn_save', 'Save', [40, 180, 320, 240], () => {}),
        ];
      case 'settings':
        return [
          t('Settings', [20, 40, 340, 90]),
          this.btn('btn_about', 'About', [40, 100, 320, 160], () => this.go('about')),
          this.btn('btn_bug', 'Trigger bug', [40, 180, 320, 240], () => {
            this.bugTaps++;
            this.crash();
          }),
          { id: this.id('switch_notif'), cls: 'android.widget.Switch', text: 'Notifications', r: [40, 260, 320, 320], clickable: true, onTap: () => {} },
        ];
      case 'about':
        return [
          t('About', [20, 40, 340, 90]),
          this.btn('btn_web', 'Open website', [40, 100, 320, 160], () => this.go('web')),
        ];
      case 'list': {
        const rows: FNode[] = [];
        for (let k = 0; k < 12; k++) {
          const top = 100 + k * 80 - this.scroll;
          if (top < 80 || top + 70 > H) continue;
          rows.push(this.btn('item_row', `Item ${k + 1}`, [0, top, W, top + 70], () => {
            this.item = k;
            this.go('detail');
          }));
        }
        return [
          t('Items', [20, 20, 340, 70]),
          { id: this.id('recycler'), cls: 'androidx.recyclerview.widget.RecyclerView', r: [0, 80, W, H], scrollable: true, children: rows },
        ];
      }
      case 'detail':
        return [
          t(`Detail #${this.item + 1}`, [20, 40, 340, 90]),
          this.btn('btn_buy', 'Add note', [40, 100, 320, 160], () => {}),
          {
            id: this.id('btn_delete'),
            cls: 'android.widget.LinearLayout',
            r: [40, 180, 320, 240],
            clickable: true,
            onTap: () => this.dangerTaps++,
            children: [{ text: 'Delete item', cls: 'android.widget.TextView', r: [60, 190, 300, 230] }],
          },
        ];
      default:
        return [];
    }
  }

  private windows(): FNode[] {
    const status: FNode = { id: 'com.android.systemui:id/status_bar', cls: 'android.widget.FrameLayout', pkg: 'com.android.systemui', r: [0, 0, W, 24], color: [10, 10, 10] };
    const wins: FNode[] = [status];

    if (this.screen === 'launcher') {
      wins.push({
        cls: 'android.widget.FrameLayout',
        pkg: 'com.android.launcher3',
        r: [0, 24, W, H],
        children: [
          { id: 'com.android.launcher3:id/icon', text: 'Fake', cls: 'android.widget.TextView', r: [20, 600, 100, 680], clickable: true, onTap: () => {} },
        ],
      });
    } else if (this.screen === 'web') {
      wins.push({
        cls: 'android.widget.FrameLayout',
        pkg: 'com.android.chrome',
        r: [0, 24, W, H],
        children: [
          { id: 'com.android.chrome:id/url_bar', text: 'example.com', cls: 'android.widget.EditText', r: [10, 40, 350, 90], clickable: true, onTap: () => {} },
        ],
      });
    } else {
      wins.push({ cls: 'android.widget.FrameLayout', pkg: this.pkg, r: [0, 24, W, H], children: this.appContent() });
    }

    if (this.permPending && this.pidNum) {
      wins.push({
        cls: 'android.widget.FrameLayout',
        pkg: 'com.google.android.permissioncontroller',
        r: [20, 420, 340, 640],
        color: [60, 60, 70],
        children: [
          { text: 'Allow Fake to access your location?', cls: 'android.widget.TextView', r: [40, 440, 320, 500] },
          {
            id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button',
            text: 'While using the app',
            cls: 'android.widget.Button',
            r: [40, 520, 320, 580],
            clickable: true,
            onTap: () => {
              this.permPending = false;
            },
          },
        ],
      });
    }
    if (this.crashDialog) {
      wins.push({
        cls: 'android.widget.FrameLayout',
        pkg: 'android',
        r: [20, 420, 340, 640],
        color: [80, 40, 40],
        children: [
          { id: 'android:id/alertTitle', text: 'Fake keeps stopping', cls: 'android.widget.TextView', r: [40, 440, 320, 500] },
          {
            id: 'android:id/aerr_close',
            text: 'Close app',
            cls: 'android.widget.Button',
            r: [40, 520, 320, 580],
            clickable: true,
            onTap: () => {
              this.crashDialog = false;
            },
          },
        ],
      });
    }
    return wins;
  }

  /** Cửa sổ trên cùng nhận chạm (hộp thoại là modal). */
  private touchable(): FNode[] {
    const wins = this.windows();
    const modal = wins.find((w) => w.pkg === 'android') ?? wins.find((w) => w.pkg?.includes('permissioncontroller'));
    return modal ? [modal] : wins;
  }

  // ----------------------------------------------------------- Device API

  async ensureReady(): Promise<void> {}

  async dumpUi(): Promise<string> {
    let i = 0;
    const emit = (n: FNode, inherited: string): string => {
      const pkg = n.pkg ?? inherited;
      const cls = n.cls ?? 'android.view.View';
      const [l, t, r, b] = n.r;
      const attrs =
        `index="${i++}" text="${esc(n.text ?? '')}" resource-id="${esc(n.id ?? '')}" class="${cls}" ` +
        `package="${pkg}" content-desc="" checkable="false" checked="false" clickable="${!!n.clickable}" ` +
        `enabled="true" focusable="${!!n.clickable}" focused="false" scrollable="${!!n.scrollable}" ` +
        `long-clickable="false" password="false" selected="false" bounds="[${l},${t}][${r},${b}]"`;
      const kids = (n.children ?? []).map((c) => emit(c, pkg)).join('');
      return kids ? `<node ${attrs}>${kids}</node>` : `<node ${attrs} />`;
    };
    const body = this.windows().map((w) => emit(w, this.pkg)).join('');
    return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${body}</hierarchy>\nUI hierarchy dumped to: /dev/tty`;
  }

  async screencap(): Promise<Buffer> {
    const px = Buffer.alloc(W * H * 3);
    const bg = BG[this.screen];
    for (let i = 0; i < W * H; i++) {
      px[i * 3] = bg[0];
      px[i * 3 + 1] = bg[1];
      px[i * 3 + 2] = bg[2];
    }
    const rect = ([l, t, r, b]: Rect, c: Color) => {
      for (let y = Math.max(0, t); y < Math.min(H, b); y++) {
        for (let x = Math.max(0, l); x < Math.min(W, r); x++) {
          const o = (y * W + x) * 3;
          px[o] = c[0];
          px[o + 1] = c[1];
          px[o + 2] = c[2];
        }
      }
    };
    const paint = (n: FNode) => {
      if (n.color) rect(n.r, n.color);
      else if (n.clickable) rect(n.r, [64, 110, 190]);
      else if (n.text) rect([n.r[0], n.r[1] + 8, n.r[0] + Math.min(200, n.r[2] - n.r[0]), n.r[1] + 18], [90, 98, 110]);
      n.children?.forEach(paint);
    };
    this.windows().forEach(paint);
    return encodePng(W, H, px);
  }

  async focusedActivity(): Promise<string> {
    const wins = this.windows();
    if (wins.some((w) => w.pkg === 'android')) return `  mCurrentFocus=Window{1a2b3c u0 Application Error: ${this.pkg}}`;
    if (wins.some((w) => w.pkg?.includes('permissioncontroller'))) {
      return '  mCurrentFocus=Window{1a2b3c u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}';
    }
    if (this.screen === 'launcher') return '  mCurrentFocus=Window{1a2b3c u0 com.android.launcher3/com.android.launcher3.Launcher}';
    if (this.screen === 'web') return '  mCurrentFocus=Window{1a2b3c u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity}';
    return `  mCurrentFocus=Window{1a2b3c u0 ${this.pkg}/${this.pkg}.${ACTIVITY[this.screen]}}`;
  }

  async pid(): Promise<string> {
    return this.pidNum ? String(this.pidNum) : '';
  }

  async tap(x: number, y: number): Promise<void> {
    let best: FNode | null = null;
    let bestArea = Infinity;
    const visit = (n: FNode) => {
      const [l, t, r, b] = n.r;
      if (n.clickable && x >= l && x < r && y >= t && y < b && (r - l) * (b - t) < bestArea) {
        best = n;
        bestArea = (r - l) * (b - t);
      }
      n.children?.forEach(visit);
    };
    this.touchable().forEach(visit);
    const hit = best as FNode | null;
    this.tapLog.push({ x, y, hit: hit?.id ?? '' });
    this.editFocused = false;
    hit?.onTap?.();
  }

  async swipe(_x1: number, y1: number, _x2: number, y2: number): Promise<void> {
    if (this.screen === 'list' && y2 < y1) this.scroll = Math.max(0, Math.min(260, this.scroll + (y1 - y2)));
  }

  async back(): Promise<void> {
    if (this.kbd) {
      this.kbd = false;
      return;
    }
    if (this.crashDialog) {
      this.crashDialog = false;
      return;
    }
    if (this.permPending && this.pidNum) {
      this.permPending = false;
      return;
    }
    if (this.screen === 'launcher') return;
    this.go(PARENT[this.screen] ?? 'launcher'); // từ màn hình chính thì thoát ra launcher, app vẫn sống
  }

  async inputText(): Promise<void> {
    if (this.editFocused) this.kbd = true;
  }

  async keyboardShown(): Promise<boolean> {
    return this.kbd;
  }

  async forceStop(): Promise<void> {
    this.pidNum = 0;
    this.screen = 'launcher';
    this.kbd = false;
  }

  async launch(): Promise<void> {
    if (!this.pidNum) {
      this.pidNum = this.nextPid++;
      this.permPending = this.firstLaunch;
      this.firstLaunch = false;
      this.screen = 'home';
    } else if (this.screen === 'launcher') {
      this.screen = 'home';
    }
  }

  async crashLog(): Promise<string> {
    return this.crashText;
  }

  async clearCrashLog(): Promise<void> {
    this.crashText = '';
  }
}
