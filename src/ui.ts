import { createHash } from 'node:crypto';
import type { Action, Screen } from './types.js';

export interface Bounds {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface UiNode {
  text: string;
  resourceId: string;
  cls: string;
  pkg: string;
  desc: string;
  clickable: boolean;
  enabled: boolean;
  scrollable: boolean;
  password: boolean;
  bounds: Bounds;
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** text + content-desc của các phần tử con. Nút bấm thường là layout rỗng chứa TextView. */
  inner: string;
  parent: number;
}

// ---------------------------------------------------------------- parsing

const TOKEN_RE = /<node((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|<\/node>/g;
const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e] ?? '';
  });
}

function parseAttrs(s: string): Record<string, string> {
  const a: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)="([^"]*)"/g)) a[m[1]] = decode(m[2]);
  return a;
}

/** Lấy phần XML từ output của `uiautomator dump /dev/tty` (có thêm dòng "UI hierarchy dumped to"). */
export function extractXml(raw: string): string | null {
  const start = raw.indexOf('<hierarchy');
  const end = raw.lastIndexOf('</hierarchy>');
  if (start < 0 || end < 0 || end < start) return null;
  return raw.slice(start, end + '</hierarchy>'.length);
}

export function parseHierarchy(xml: string): UiNode[] {
  const out: UiNode[] = [];
  const stack: number[] = []; // chỉ số node đang mở, -1 nếu node không đọc được
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[0] === '</node>') {
      stack.pop();
      continue;
    }
    const selfClosing = m[2] === '/';
    const a = parseAttrs(m[1] ?? '');
    const bm = BOUNDS_RE.exec(a.bounds ?? '');
    if (!bm) {
      if (!selfClosing) stack.push(-1);
      continue;
    }
    const l = +bm[1];
    const t = +bm[2];
    const r = +bm[3];
    const b = +bm[4];
    const parent = stack.length ? stack[stack.length - 1] : -1;
    const node: UiNode = {
      text: a.text ?? '',
      resourceId: a['resource-id'] ?? '',
      cls: a.class ?? '',
      pkg: a.package ?? '',
      desc: a['content-desc'] ?? '',
      clickable: a.clickable === 'true',
      enabled: a.enabled !== 'false',
      scrollable: a.scrollable === 'true',
      password: a.password === 'true',
      bounds: { l, t, r, b },
      cx: Math.round((l + r) / 2),
      cy: Math.round((t + b) / 2),
      w: r - l,
      h: b - t,
      inner: '',
      parent,
    };
    const idx = out.push(node) - 1;
    const label = [node.text, node.desc].filter(Boolean).join(' ');
    if (label) {
      for (let p = parent; p >= 0; p = out[p].parent) {
        if (out[p].inner.length < 300) out[p].inner += ' ' + label;
      }
    }
    if (!selfClosing) stack.push(idx);
  }
  return out;
}

export function inferScreen(nodes: UiNode[]): Screen {
  let w = 0;
  let h = 0;
  for (const n of nodes) {
    w = Math.max(w, n.bounds.r);
    h = Math.max(h, n.bounds.b);
  }
  return { w: w || 1080, h: h || 1920 };
}

/** "MainActivity" từ dòng `mCurrentFocus=Window{... u0 com.pkg/com.pkg.MainActivity}` */
export function parseActivity(focus: string): string {
  const m = /([A-Za-z_][\w.]*)\/([A-Za-z_.$][\w.$]*)/.exec(focus);
  if (!m) return '';
  const cls = m[2];
  if (cls.startsWith(m[1] + '.')) return cls.slice(m[1].length + 1);
  return cls.startsWith('.') ? cls.slice(1) : cls;
}

// ---------------------------------------------------------------- elements

export function isEditable(n: UiNode): boolean {
  return /(EditText|AutoCompleteTextView)$/.test(n.cls);
}

/** Ô lưới thô, dùng khi phần tử không có resource-id. */
function gridCell(n: UiNode): string {
  return `${Math.round(n.cx / 180)},${Math.round(n.cy / 320)}`;
}

export function nodeLabel(n: UiNode): string {
  const s =
    n.text ||
    n.desc ||
    n.inner.trim() ||
    n.resourceId.split('/').pop() ||
    n.cls.split('.').pop() ||
    '';
  return s.slice(0, 60);
}

/** Định danh phần tử trong một màn hình, dùng để nhớ cái nào đã thử. */
export function elementKey(n: UiNode): string {
  return `${n.resourceId}|${n.cls}|${nodeLabel(n).slice(0, 40)}|${gridCell(n)}`;
}

export function isBlacklisted(n: UiNode, blacklist: string[]): boolean {
  if (!blacklist.length) return false;
  const hay = `${n.text}\n${n.desc}\n${n.resourceId}\n${n.inner}`.toLowerCase();
  return blacklist.some((w) => w && hay.includes(w.toLowerCase()));
}

/**
 * Chữ ký màn hình = activity + tập hình dạng của các phần tử tương tác
 * (resource-id + class). Cố ý bỏ text để giờ, số đếm, nội dung danh sách
 * không biến mọi màn hình thành "mới".
 */
export function screenSignature(activity: string, nodes: UiNode[], pkg: string): string {
  const keys = new Set<string>();
  for (const n of nodes) {
    if (n.pkg !== pkg) continue;
    if (!(n.clickable || n.scrollable || isEditable(n))) continue;
    keys.add(`${n.resourceId || '~'}|${n.cls}|${n.resourceId ? '' : gridCell(n)}`);
  }
  const h = createHash('sha1');
  h.update(activity + '\n' + [...keys].sort().join('\n'));
  return h.digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------- system dialogs

export type SystemDialog =
  | { kind: 'permission'; button: UiNode }
  | { kind: 'crash'; anr: boolean; message: string; button: UiNode | null };

const CRASH_RE = /has stopped|keeps stopping|stopped working|isn't responding|is not responding|not responding/i;
const PERMISSION_PKG_RE = /permissioncontroller|packageinstaller/;
const ALLOW_IDS = [
  /permission_allow_foreground_only_button$/,
  /permission_allow_button$/,
  /permission_allow_one_time_button$/,
];
const ALLOW_TEXTS = [/^while using the app$/i, /^allow$/i, /^only this time$/i, /^allow all$/i];

export function detectSystemDialog(nodes: UiNode[]): SystemDialog | null {
  const sys = nodes.filter((n) => n.pkg === 'android');
  const closeBtn = sys.find((n) => n.resourceId === 'android:id/aerr_close') ?? null;
  const waitBtn = sys.find((n) => n.resourceId === 'android:id/aerr_wait') ?? null;
  const msg = sys.find((n) => CRASH_RE.test(n.text));
  if (closeBtn || waitBtn || msg) {
    const message = msg?.text ?? '';
    const button =
      closeBtn ??
      sys.find((n) => n.clickable && n.enabled && /^(close app|close|ok)$/i.test(n.text)) ??
      null;
    return { kind: 'crash', anr: !!waitBtn || /respond/i.test(message), message, button };
  }

  const perm = nodes.filter((n) => PERMISSION_PKG_RE.test(n.pkg));
  if (perm.length) {
    const buttons = perm.filter((n) => n.clickable && n.enabled);
    for (const re of ALLOW_IDS) {
      const b = buttons.find((n) => re.test(n.resourceId));
      if (b) return { kind: 'permission', button: b };
    }
    for (const re of ALLOW_TEXTS) {
      const b = buttons.find((n) => re.test(n.text.trim()));
      if (b) return { kind: 'permission', button: b };
    }
  }
  return null;
}

// ---------------------------------------------------------------- choosing an action

export interface PickInput {
  nodes: UiNode[];
  pkg: string;
  screen: Screen;
  tried: Set<string>;
  blacklist: string[];
  rng: () => number;
  inputText?: (n: UiNode) => string;
}

export interface PickResult {
  action: Action;
  /** Khóa cần đánh dấu "đã thử" sau khi thực hiện */
  key?: string;
  /** Số thứ còn chưa thử ở màn hình này SAU khi thực hiện hành động vừa chọn */
  remaining: number;
  skipped: { key: string; label: string; id: string }[];
}

const MAX_SWIPES_PER_LIST = 3;

export function defaultInputText(n: UiNode): string {
  const hay = `${n.resourceId} ${n.desc} ${n.text}`.toLowerCase();
  if (/mail/.test(hay)) return 'test@example.com';
  if (/phone|tel|mobile/.test(hay)) return '0912345678';
  if (/name/.test(hay)) return 'Test User';
  return 'test';
}

/** Các phần tử của app được phép tương tác: đúng package, bật, nằm trong màn hình, không dính blacklist. */
function collectUsable(
  nodes: UiNode[],
  pkg: string,
  screen: Screen,
  blacklist: string[],
): { usable: UiNode[]; skipped: PickResult['skipped'] } {
  const skipped: PickResult['skipped'] = [];
  const skippedKeys = new Set<string>();
  const usable: UiNode[] = [];
  const onScreen = (n: UiNode) =>
    n.w > 0 && n.h > 0 && n.cx >= 0 && n.cy >= 0 && n.cx < screen.w && n.cy < screen.h;

  for (const n of nodes) {
    if (n.pkg !== pkg || !n.enabled || !onScreen(n)) continue;
    if (!(n.clickable || n.scrollable || isEditable(n))) continue;
    if ((n.clickable || isEditable(n)) && isBlacklisted(n, blacklist)) {
      const key = elementKey(n);
      if (!skippedKeys.has(key)) {
        skippedKeys.add(key);
        skipped.push({ key, label: nodeLabel(n), id: n.resourceId });
      }
      continue;
    }
    usable.push(n);
  }
  return { usable, skipped };
}

/** Phần tử bấm được (không phải ô nhập) mà explorer có quyền bấm, dùng để đi theo đường đã biết. */
export function tappableNodes(nodes: UiNode[], pkg: string, screen: Screen, blacklist: string[]): UiNode[] {
  return collectUsable(nodes, pkg, screen, blacklist).usable.filter((n) => n.clickable && !isEditable(n));
}

interface Survey {
  fields: UiNode[];
  clicks: UiNode[];
  scrolls: { node: UiNode; key: string }[];
}

function survey(usable: UiNode[], tried: Set<string>): Survey {
  const fields = usable.filter((n) => isEditable(n) && !n.password && !tried.has(elementKey(n)));
  const clicks = usable.filter((n) => n.clickable && !isEditable(n) && !tried.has(elementKey(n)));
  const scrolls: Survey['scrolls'] = [];
  for (const n of usable.filter((x) => x.scrollable)) {
    for (let i = 0; i < MAX_SWIPES_PER_LIST; i++) {
      const key = `swipe${i}:${elementKey(n)}`;
      if (!tried.has(key)) {
        scrolls.push({ node: n, key });
        break;
      }
    }
  }
  return { fields, clicks, scrolls };
}

const countOf = (s: Survey) => s.fields.length + s.clicks.length + s.scrolls.length;

/**
 * Thứ tự ưu tiên:
 *  1. ô nhập chưa điền (để form hợp lệ trước khi bấm nút gửi)
 *  2. phần tử bấm được chưa thử ở màn hình này (ngẫu nhiên có seed)
 *  3. vuốt danh sách cuộn (tối đa vài lần mỗi danh sách)
 *  4. BACK (explorer sẽ thử đi theo đường đã biết tới màn hình còn việc trước khi thật sự BACK)
 */
export function pickAction(inp: PickInput): PickResult {
  const { pkg, screen, tried, blacklist, rng } = inp;
  const { usable, skipped } = collectUsable(inp.nodes, pkg, screen, blacklist);
  const now = survey(usable, tried);

  const done = (action: Action, key?: string): PickResult => {
    let remaining = countOf(now);
    if (key) {
      const after = new Set(tried);
      after.add(key);
      remaining = countOf(survey(usable, after));
    }
    return { action, key, remaining, skipped };
  };

  if (now.fields.length) {
    const n = now.fields[0];
    const text = (inp.inputText ?? defaultInputText)(n);
    return done({ type: 'type', x: n.cx, y: n.cy, id: n.resourceId, text }, elementKey(n));
  }

  if (now.clicks.length) {
    // Tránh layout phủ gần hết màn hình trừ khi không còn gì khác.
    const normal = now.clicks.filter((n) => n.w * n.h < 0.9 * screen.w * screen.h);
    const pool = normal.length ? normal : now.clicks;
    const n = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
    return done({ type: 'tap', x: n.cx, y: n.cy, id: n.resourceId, label: nodeLabel(n) }, elementKey(n));
  }

  if (now.scrolls.length) {
    const { node: n, key } = now.scrolls[0];
    const clampY = (y: number) => Math.max(0, Math.min(screen.h - 1, Math.round(y)));
    return done(
      {
        type: 'swipe',
        x: n.cx,
        y: clampY(n.bounds.t + n.h * 0.75),
        x2: n.cx,
        y2: clampY(n.bounds.t + n.h * 0.25),
        id: n.resourceId,
      },
      key,
    );
  }

  return done({ type: 'back' });
}
