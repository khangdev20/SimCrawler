import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board } from './board.js';
import { Explorer, type RunControl } from './explorer.js';
import { Recorder } from './recorder.js';
import type { Config, Device, RunSummary } from './types.js';

export interface RunCrawlOptions {
  cfg: Config;
  devices: Device[];
  board: Board;
  ctl: RunControl;
}

export async function runCrawl({ cfg, devices, board, ctl }: RunCrawlOptions): Promise<RunSummary> {
  const startedAt = new Date();
  const runDir = join(cfg.outDir, startedAt.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });

  if (!board.meta.package) {
    board.meta.package = cfg.package;
  }
  const recorders = devices.map((d) => {
    board.register(d.serial);
    return new Recorder(runDir, d.serial, board);
  });

  const deadline = Date.now() + cfg.maxMinutes * 60_000;
  board.meta.maxMinutes = cfg.maxMinutes;
  board.meta.deadline = deadline;
  const summaries = await Promise.all(
    devices.map((d, i) => new Explorer(d, cfg, recorders[i], ctl, i).run(deadline)),
  );

  const summary: RunSummary = {
    package: cfg.package,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    runDir,
    devices: summaries,
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  return summary;
}
