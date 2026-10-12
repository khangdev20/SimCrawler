import { setTimeout as sleep } from 'node:timers/promises';
import { summarizeCrash } from './crash.js';
import { pngSize } from './png.js';
import type { Media, Recorder } from './recorder.js';
import type {
  Action,
  Config,
  Device,
  DeviceSummary,
  Marker,
  Screen,
  ScreenInfo,
  SkippedItem,
  Stats,
  StopReason,
} from './types.js';
import {
  detectSystemDialog,
  elementKey,
  extractXml,
  inferScreen,
  nodeLabel,
  parseActivity,
  parseHierarchy,
  pickAction,
  screenSignature,
  tappableNodes,
  type SystemDialog,
  type UiNode,
} from './ui.js';

export interface RunControl {
  stopped: boolean;
}

/** RNG có seed, để hai lần chạy cùng seed đi cùng đường. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function markerOf(a: Action): Marker | null {
  return a.type === 'tap' || a.type === 'type' || a.type === 'swipe' ? { x: a.x, y: a.y } : null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Một thiết bị = một Explorer = một vòng lặp, không chia sẻ trạng thái với máy khác. */
export class Explorer {
  private step = 0;
  private readonly rng: () => number;
  private readonly seen = new Map<string, ScreenInfo>();
  private readonly tried = new Map<string, Set<string>>();
  private readonly skipped = new Map<string, SkippedItem>();
  /** Đồ thị đã quan sát: màn hình A, bấm phần tử X, sang màn hình B. */
  private readonly edges = new Map<string, Map<string, string>>();
  /** Số thứ chưa thử ở mỗi màn hình, cập nhật mỗi lần ghé thăm. */
  private readonly remaining = new Map<string, number>();
  private pendingEdge: { from: string; key: string } | null = null;
  /** Màn hình mà lần BACK vừa rồi được bấm ở đó, để biết BACK có thoát khỏi app không. */
  private pendingBack: string | null = null;
  /** Các màn hình mà BACK thoát khỏi app (thường là màn hình gốc). Không BACK ở đó nữa. */
  private readonly backExits = new Set<string>();
  private cur = { activity: '', sig: '' };
  private stale = 0;
  private productive = 0;
  private idleWindows = 0;
  private lastPid = '';
  private lastCrashStep = -100;
  private leftCount = 0;
  private dumpFails = 0;
  private dialogStreak = 0;
  private stopReason: StopReason = 'time';
  private readonly counts = { crashes: 0, anrs: 0, relaunches: 0, stuck: 0, leftApp: 0, errors: 0 };

  constructor(
    private readonly dev: Device,
    private readonly cfg: Config,
    private readonly rec: Recorder,
    private readonly ctl: RunControl,
    index = 0,
  ) {
    this.rng = mulberry32(cfg.seed + index * 7919);
  }

  async run(deadline: number): Promise<DeviceSummary> {
    const t0 = Date.now();
    let consecutiveErrors = 0;
    this.rec.status('running');
    try {
      await this.dev.clearCrashLog().catch(() => {});
      await this.relaunch('start');
      for (;;) {
        const stop = this.shouldStop(deadline);
        if (stop) {
          this.stopReason = stop;
          break;
        }
        try {
          await this.tick();
          consecutiveErrors = 0;
        } catch (e) {
          this.counts.errors++;
          consecutiveErrors++;
          await this.emit({ event: 'error', note: errMsg(e), alive: false });
          if (consecutiveErrors >= 8) {
            this.stopReason = 'device_error';
            break;
          }
          await sleep(Math.min(2000, this.cfg.stepDelayMs * 2 + 20));
        }
      }
    } catch (e) {
      this.counts.errors++;
      this.stopReason = 'device_error';
      await this.emit({ event: 'error', note: errMsg(e), alive: false }).catch(() => {});
    } finally {
      this.rec.stats = this.stats();
      this.rec.status('done', this.stopReason);
    }
    return this.summary(Date.now() - t0);
  }

  private shouldStop(deadline: number): StopReason | null {
    if (this.ctl.stopped) return 'interrupted';
    if (Date.now() >= deadline) return 'time';
    if (this.cfg.maxSteps > 0 && this.step >= this.cfg.maxSteps) return 'steps';
    if (this.idleWindows >= 2) return 'saturated';
    return null;
  }

  // ------------------------------------------------------------ one step

  private async tick(): Promise<void> {
    const { cfg, dev } = this;
    this.step++;
    // Cạnh chờ xác nhận chỉ hợp lệ nếu bước ngay sau là một màn hình bình thường của app.
    const pe = this.pendingEdge;
    this.pendingEdge = null;
    const pb = this.pendingBack;
    this.pendingBack = null;

    const obs = await this.observe();
    if (!obs) return this.onDumpFailed();
    this.dumpFails = 0;
    const { nodes, shot, focus } = obs;
    const screen: Screen = (shot ? pngSize(shot) : null) ?? inferScreen(nodes);

    const dialog = detectSystemDialog(nodes);
    if (dialog) return this.onDialog(dialog, shot, screen);
    this.dialogStreak = 0;

    if (!nodes.some((n) => n.pkg === cfg.package)) return this.onLeftApp(nodes, shot, screen, pb);
    this.leftCount = 0;

    const activity = parseActivity(focus);
    const sig = screenSignature(activity, nodes, cfg.package);
    this.cur = { activity, sig };
    const isNew = !this.seen.has(sig);
    if (isNew) {
      this.seen.set(sig, { sig, activity, firstSeenStep: this.step });
      this.stale = 0;
      this.productive = 0;
      this.idleWindows = 0;
    } else {
      this.stale++;
    }
    if (pe && pe.from !== sig) this.link(pe.from, pe.key, sig);
    // Kiểm tra "kẹt" SAU khi quan sát: nếu hành động vừa rồi dẫn tới màn hình mới thì stale đã về 0,
    // và kết quả của nó không bị bỏ qua bởi một lần mở lại app.
    if (this.stale >= cfg.staleStepsBeforeRelaunch) return this.onStuck();

    let tried = this.tried.get(sig);
    if (!tried) this.tried.set(sig, (tried = new Set()));
    const pick = pickAction({
      nodes,
      pkg: cfg.package,
      screen,
      tried,
      blacklist: cfg.blacklist,
      rng: this.rng,
    });
    for (const s of pick.skipped) {
      const k = `${sig}|${s.key}`;
      if (!this.skipped.has(k)) {
        this.skipped.set(k, { label: s.label, id: s.id, sig, step: this.step });
      }
    }
    if (pick.key) tried.add(pick.key);
    this.remaining.set(sig, pick.remaining);

    let a = pick.action;
    let edgeKey = pick.key;
    let note: string | undefined;
    let exploring = a.type === 'tap' || a.type === 'type' || a.type === 'swipe';
    if (a.type === 'back') {
      // Hết việc ở màn hình này: đi theo đường đã biết tới màn hình còn phần tử chưa thử.
      const nav = this.navigate(nodes, sig, screen);
      if (nav) {
        a = nav.action;
        edgeKey = nav.key;
        note = `đi tới ${nav.target}`;
        exploring = false; // đi đường, chưa phải khám phá
      } else if (this.backExits.has(sig)) {
        // Không còn gì để thử và BACK ở đây sẽ thoát app: coi như đã hết, khỏi lặp "thoát rồi mở lại".
        this.stale = cfg.staleStepsBeforeRelaunch;
        return this.onStuck(true);
      }
    }
    await this.execute(a);
    if (a.type === 'tap' && edgeKey) this.pendingEdge = { from: sig, key: edgeKey };
    if (a.type === 'back') this.pendingBack = sig;
    if (exploring) this.productive++;
    await sleep(cfg.stepDelayMs);

    const marker = markerOf(a);
    const media: Media = { shot, marker, screen };
    const proc = await this.checkProcess();
    if (proc === 'ok') {
      await this.emit({ action: a, newScreen: isNew, note }, media);
    } else if (proc === 'not_running') {
      await this.emit({ action: a, newScreen: isNew, alive: false, note }, media);
      await this.relaunch('not_running');
    } else {
      await this.emit({ action: a, newScreen: isNew, alive: proc === 'restarted', note }, media);
      await this.onCrash(proc, a, shot, marker, screen);
    }
  }

  private link(from: string, key: string, to: string): void {
    let out = this.edges.get(from);
    if (!out) this.edges.set(from, (out = new Map()));
    out.set(key, to);
  }

  /**
   * BFS trên đồ thị đã quan sát, bắt đầu từ màn hình hiện tại, tới màn hình gần nhất
   * còn phần tử chưa thử. Chỉ dùng cạnh mà phần tử đó đang có mặt trên màn hình lúc này.
   */
  private navigate(
    nodes: UiNode[],
    sig: string,
    screen: Screen,
  ): { action: Action; key: string; target: string } | null {
    const out = this.edges.get(sig);
    if (!out || out.size === 0) return null;
    const here = new Map<string, UiNode>();
    for (const n of tappableNodes(nodes, this.cfg.package, screen, this.cfg.blacklist)) {
      const k = elementKey(n);
      if (!here.has(k)) here.set(k, n);
    }
    const seen = new Set<string>([sig]);
    const queue: { sig: string; first: string }[] = [];
    for (const [key, to] of out) {
      if (here.has(key) && !seen.has(to)) {
        seen.add(to);
        queue.push({ sig: to, first: key });
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if ((this.remaining.get(cur.sig) ?? 0) > 0) {
        const n = here.get(cur.first)!;
        return {
          action: { type: 'tap', x: n.cx, y: n.cy, id: n.resourceId, label: nodeLabel(n) },
          key: cur.first,
          target: this.seen.get(cur.sig)?.activity || cur.sig,
        };
      }
      const next: Map<string, string> = this.edges.get(cur.sig) ?? new Map();
      for (const [, to] of next) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push({ sig: to, first: cur.first });
        }
      }
    }
    return null;
  }

  /** dump + screenshot + activity cùng lúc để ảnh khớp với cây UI. Thử lại vài lần vì uiautomator hay lỗi. */
  private async observe(): Promise<{ nodes: UiNode[]; shot: Buffer | null; focus: string } | null> {
    const retryMs = Math.min(600, this.cfg.stepDelayMs);
    for (let i = 0; i < 3; i++) {
      const [raw, shot, focus] = await Promise.all([
        this.dev.dumpUi().catch(() => ''),
        this.dev.screencap().catch(() => null),
        this.dev.focusedActivity().catch(() => ''),
      ]);
      const xml = extractXml(raw);
      if (xml) {
        const nodes = parseHierarchy(xml);
        if (nodes.length) return { nodes, shot, focus };
      }
      await sleep(retryMs);
    }
    return null;
  }

  private async execute(a: Action): Promise<void> {
    const { dev } = this;
    switch (a.type) {
      case 'tap':
        await dev.tap(a.x, a.y);
        break;
      case 'type':
        await dev.tap(a.x, a.y);
        await sleep(Math.min(200, this.cfg.stepDelayMs));
        await dev.inputText(a.text);
        if (await dev.keyboardShown()) await dev.back(); // đóng bàn phím, không rời màn hình
        break;
      case 'swipe':
        await dev.swipe(a.x, a.y, a.x2, a.y2, 300);
        break;
      case 'back':
        await dev.back();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ process / crash

  private async checkProcess(): Promise<'ok' | 'died' | 'restarted' | 'not_running'> {
    const pid = await this.dev.pid(this.cfg.package);
    if (pid === '') {
      const had = this.lastPid !== '';
      this.lastPid = '';
      return had ? 'died' : 'not_running';
    }
    if (!this.lastPid) {
      this.lastPid = pid;
      return 'ok';
    }
    if (pid !== this.lastPid) {
      this.lastPid = pid;
      return 'restarted';
    }
    return 'ok';
  }

  private async onCrash(
    kind: 'died' | 'restarted',
    a: Action,
    shot: Buffer | null,
    marker: Marker | null,
    screen: Screen,
  ): Promise<void> {
    const raw = await this.dev.crashLog().catch(() => '');
    await this.dev.clearCrashLog().catch(() => {});
    const after = await this.dev.screencap().catch(() => null);
    this.counts.crashes++;
    this.lastCrashStep = this.step;
    const what = kind === 'died' ? 'process đã chết' : 'process tự khởi động lại';
    await this.emit(
      {
        event: 'crash',
        note: [what, summarizeCrash(raw)].filter(Boolean).join(': '),
        action: a,
        alive: false,
      },
      { shot, shotAfter: after, crashLog: raw, marker, screen, persist: true },
    );
    await this.relaunch('crash');
  }

  private async onDialog(d: SystemDialog, shot: Buffer | null, screen: Screen): Promise<void> {
    const { dev, cfg } = this;
    this.dialogStreak++;

    if (this.dialogStreak > 6) {
      this.dialogStreak = 0;
      await this.emit({ event: 'dialog_dismissed', note: 'không đóng được hộp thoại, đóng app' });
      return this.relaunch('dialog_stuck');
    }

    if (d.kind === 'permission') {
      const b = d.button;
      const label = nodeLabel(b);
      const action: Action = { type: 'tap', x: b.cx, y: b.cy, id: b.resourceId, label };
      await dev.tap(b.cx, b.cy);
      await this.emit({ event: 'permission', note: label, action }, { shot, marker: markerOf(action), screen });
      await sleep(cfg.stepDelayMs);
      return;
    }

    // crash/ANR do hệ thống hiện. Hộp thoại của lần crash vừa ghi nhận thì không đếm lại.
    const recent = this.dialogStreak > 1 || this.step - this.lastCrashStep <= 3;
    const kind = d.anr ? 'anr' : 'crash';
    if (!recent) {
      if (d.anr) this.counts.anrs++;
      else this.counts.crashes++;
      this.lastCrashStep = this.step;
      const raw = await dev.crashLog().catch(() => '');
      await dev.clearCrashLog().catch(() => {});
      await this.emit(
        {
          event: kind,
          note: [d.message, summarizeCrash(raw)].filter(Boolean).join(' — '),
          alive: false,
        },
        { shot, crashLog: raw, screen, persist: true },
      );
    }
    let action: Action = { type: 'back' };
    if (d.button) {
      action = { type: 'tap', x: d.button.cx, y: d.button.cy, id: d.button.resourceId, label: nodeLabel(d.button) };
      await dev.tap(d.button.cx, d.button.cy);
    } else {
      await dev.back();
    }
    await this.emit({ event: 'dialog_dismissed', note: d.message || kind, action }, { shot, marker: markerOf(action), screen });
    await sleep(cfg.stepDelayMs);
    if (!recent) await this.relaunch(`${kind}_dialog`);
  }

  // ------------------------------------------------------------ navigation problems

  private async onLeftApp(nodes: UiNode[], shot: Buffer | null, screen: Screen, backFrom: string | null): Promise<void> {
    if (backFrom) this.backExits.add(backFrom);
    this.counts.leftApp++;
    this.leftCount++;
    this.stale++;
    this.cur = { activity: '', sig: '' };
    if (this.stale >= this.cfg.staleStepsBeforeRelaunch) return this.onStuck();
    const other = nodes.find((n) => n.pkg && !n.pkg.startsWith('com.android.systemui'))?.pkg ?? '';
    if (this.leftCount <= 2) {
      await this.dev.back();
      await this.emit({ event: 'left_app', note: other, action: { type: 'back' } }, { shot, screen });
      await sleep(this.cfg.stepDelayMs);
    } else {
      await this.emit({ event: 'left_app', note: `${other} → mở lại app` }, { shot, screen });
      await this.relaunch('left_app');
    }
  }

  private async onStuck(deadEnd = false): Promise<void> {
    this.counts.stuck++;
    const idle = this.productive === 0;
    this.idleWindows = idle ? this.idleWindows + 1 : 0;
    this.productive = 0;
    this.stale = 0;
    await this.emit({
      event: 'stuck',
      note: deadEnd
        ? 'không còn gì để thử và BACK sẽ thoát app'
        : `${this.cfg.staleStepsBeforeRelaunch} bước không có màn hình mới${idle ? ', không còn gì để thử' : ''}`,
    });
    if (this.idleWindows >= 2) return; // hết thứ để thử: vòng lặp sẽ dừng với lý do "saturated"
    await this.relaunch('stuck');
  }

  private async onDumpFailed(): Promise<void> {
    this.dumpFails++;
    await this.emit({ event: 'dump_failed', note: `lần ${this.dumpFails}` });
    if (this.dumpFails >= 5) {
      this.dumpFails = 0;
      await this.relaunch('dump_failed');
    } else {
      await sleep(Math.min(1000, this.cfg.stepDelayMs));
    }
  }

  private async relaunch(reason: string): Promise<void> {
    const { dev, cfg } = this;
    this.pendingEdge = null;
    this.pendingBack = null;
    await dev.forceStop(cfg.package);
    await dev.launch(cfg.package);
    if (reason !== 'start') this.counts.relaunches++;
    await sleep(cfg.launchWaitMs);
    this.lastPid = '';
    for (let i = 0; i < 6; i++) {
      const pid = await dev.pid(cfg.package).catch(() => '');
      if (pid) {
        this.lastPid = pid;
        break;
      }
      await sleep(Math.min(500, cfg.launchWaitMs));
    }
    this.leftCount = 0;
    this.dialogStreak = 0;
    await this.emit({ event: reason === 'start' ? 'start' : 'relaunch', note: reason, action: { type: 'relaunch' } });
  }

  // ------------------------------------------------------------ bookkeeping

  private async emit(
    p: { event?: string; note?: string; action?: Action; newScreen?: boolean; alive?: boolean },
    media?: Media,
  ) {
    this.rec.stats = this.stats();
    return this.rec.record(
      {
        step: this.step,
        activity: this.cur.activity,
        sig: this.cur.sig,
        action: p.action ?? { type: 'none' },
        newScreen: p.newScreen ?? false,
        alive: p.alive ?? true,
        ...(p.event ? { event: p.event } : {}),
        ...(p.note ? { note: p.note } : {}),
      },
      media,
    );
  }

  private stats(): Stats {
    return { steps: this.step, uniqueScreens: this.seen.size, ...this.counts };
  }

  private summary(ms: number): DeviceSummary {
    return {
      serial: this.dev.serial,
      durationSec: Math.round(ms / 100) / 10,
      stopReason: this.stopReason,
      untriedElements: [...this.remaining.values()].reduce((a, b) => a + b, 0),
      ...this.stats(),
      screens: [...this.seen.values()],
      skippedByBlacklist: [...this.skipped.values()],
    };
  }
}
