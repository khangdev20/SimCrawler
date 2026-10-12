import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_STATS, type Board, type DevStatus, type LineView } from './board.js';
import type { Action, Marker, Screen, Stats, StepRecord } from './types.js';

export type NewRecord = Omit<StepRecord, 't' | 'dev'>;

export interface Media {
  shot?: Buffer | null;
  shotAfter?: Buffer | null;
  crashLog?: string;
  marker?: Marker | null;
  screen?: Screen | null;
  /** true: ghi ảnh/crash log ra đĩa (chỉ dùng cho crash/ANR). Dashboard luôn nhận ảnh. */
  persist?: boolean;
}

function describeAction(a: Action): string {
  switch (a.type) {
    case 'tap':
      return `tap ${a.id.split('/').pop() || '~'} "${a.label}"`;
    case 'type':
      return `type ${a.id.split('/').pop() || '~'} "${a.text}"`;
    case 'swipe':
      return `swipe ${a.id.split('/').pop() || '~'}`;
    case 'back':
      return 'back';
    case 'relaunch':
      return 'relaunch';
    default:
      return '';
  }
}

export class Recorder {
  stats: Stats = { ...EMPTY_STATS };
  private readonly file: string;
  private readonly safe: string;

  constructor(
    private readonly runDir: string,
    readonly serial: string,
    private readonly board: Board,
  ) {
    this.safe = serial.replace(/[^\w.-]/g, '_');
    mkdirSync(join(runDir, 'shots'), { recursive: true });
    mkdirSync(join(runDir, 'crashes'), { recursive: true });
    this.file = join(runDir, `${this.safe}.jsonl`);
  }

  status(s: DevStatus, stopReason = ''): void {
    this.board.setStatus(this.serial, s, stopReason);
  }

  record(rec: NewRecord, media: Media = {}): StepRecord {
    const full: StepRecord = { t: new Date().toISOString(), dev: this.serial, ...rec };
    const tag = `${this.safe}-s${rec.step}${rec.event ? '-' + rec.event : ''}`;

    if (media.persist) {
      if (media.shot) {
        full.shot = join('shots', `${tag}.png`);
        writeFileSync(join(this.runDir, full.shot), media.shot);
      }
      if (media.shotAfter) {
        full.shotAfter = join('shots', `${tag}-after.png`);
        writeFileSync(join(this.runDir, full.shotAfter), media.shotAfter);
      }
      if (media.crashLog) {
        full.crashLog = join('crashes', `${tag}.log`);
        writeFileSync(join(this.runDir, full.crashLog), media.crashLog);
      }
    }

    appendFileSync(this.file, JSON.stringify(full) + '\n');

    const line: LineView = {
      t: full.t.slice(11, 19),
      step: full.step,
      kind: full.event ? 'event' : 'step',
      text: full.event
        ? `${full.event}${full.note ? ': ' + full.note : ''}`
        : describeAction(full.action) +
          (full.note ? ` (${full.note})` : '') +
          (full.newScreen ? `  ★ ${full.activity || full.sig}` : ''),
      event: full.event,
    };
    this.board.push(this.serial, {
      stats: this.stats,
      line,
      shot: media.shot,
      screen: media.screen,
      marker: media.marker,
    });
    return full;
  }
}
