import { EventEmitter } from 'node:events';
import type { Marker, Screen, Stats } from './types.js';

export type DevStatus = 'waiting' | 'running' | 'done';

export interface LineView {
  t: string;
  step: number;
  kind: 'step' | 'event';
  text: string;
  event?: string;
}

export interface DevState {
  serial: string;
  status: DevStatus;
  stopReason: string;
  stats: Stats;
  lines: LineView[];
  shot: Buffer | null;
  shotSeq: number;
  screen: Screen | null;
  marker: Marker | null;
}

export const EMPTY_STATS: Stats = {
  steps: 0,
  uniqueScreens: 0,
  crashes: 0,
  anrs: 0,
  relaunches: 0,
  stuck: 0,
  leftApp: 0,
  errors: 0,
};

const MAX_LINES = 300;

/**
 * Bảng trạng thái chỉ-đọc cho dashboard. Explorer ghi vào đây (qua Recorder),
 * dashboard chỉ lắng nghe và hiển thị, không điều khiển gì ngược lại.
 */
export class Board extends EventEmitter {
  readonly devices: DevState[] = [];
  meta: { package: string; maxMinutes?: number; deadline?: number } = { package: '' };

  register(serial: string): number {
    this.devices.push({
      serial,
      status: 'waiting',
      stopReason: '',
      stats: { ...EMPTY_STATS },
      lines: [],
      shot: null,
      shotSeq: 0,
      screen: null,
      marker: null,
    });
    return this.devices.length - 1;
  }

  private indexOf(serial: string): number {
    const i = this.devices.findIndex((d) => d.serial === serial);
    if (i < 0) throw new Error(`Thiết bị chưa đăng ký: ${serial}`);
    return i;
  }

  setStatus(serial: string, status: DevStatus, stopReason = ''): void {
    const i = this.indexOf(serial);
    this.devices[i].status = status;
    this.devices[i].stopReason = stopReason;
    this.emit('update', this.payload(i));
  }

  push(
    serial: string,
    p: {
      stats: Stats;
      line?: LineView;
      shot?: Buffer | null;
      screen?: Screen | null;
      marker?: Marker | null;
    },
  ): void {
    const i = this.indexOf(serial);
    const d = this.devices[i];
    d.stats = { ...p.stats };
    if (p.shot) {
      d.shot = p.shot;
      d.shotSeq++;
      d.screen = p.screen ?? d.screen;
      d.marker = p.marker ?? null;
    }
    if (p.line) {
      d.lines.push(p.line);
      if (d.lines.length > MAX_LINES) d.lines.splice(0, d.lines.length - MAX_LINES);
    }
    this.emit('update', this.payload(i, p.line));
  }

  payload(i: number, line?: LineView) {
    const d = this.devices[i];
    return {
      index: i,
      serial: d.serial,
      status: d.status,
      stopReason: d.stopReason,
      stats: d.stats,
      shotSeq: d.shotSeq,
      marker: d.marker && d.screen ? { x: d.marker.x / d.screen.w, y: d.marker.y / d.screen.h } : null,
      line,
    };
  }

  snapshot() {
    return {
      package: this.meta.package,
      maxMinutes: this.meta.maxMinutes,
      deadline: this.meta.deadline,
      devices: this.devices.map((d, i) => ({ ...this.payload(i), lines: d.lines })),
    };
  }
}
