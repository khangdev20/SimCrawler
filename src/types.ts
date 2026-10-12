/** Tự khởi động Android emulator (AVD) trước khi chạy. Không có khối này thì hành vi như cũ. */
export interface EmulatorsConfig {
  autoStart: boolean;
  /** serial (emulator-<cổng>) -> tên AVD. Serial không có ở đây coi như người dùng tự bật. */
  avds: Record<string, string>;
  /** Thêm -no-window */
  headless: boolean;
  bootTimeoutSec: number;
  /** Tắt các emulator do chính mình bật khi chạy xong / bị Ctrl-C */
  closeWhenDone: boolean;
  /** Thêm -read-only (bắt buộc khi hai serial dùng chung một AVD) */
  readOnly: boolean;
}

export interface Config {
  /** Package của app được giao, ví dụ com.example.app */
  package: string;
  /** Serial của các thiết bị (adb devices), mỗi máy chạy một vòng lặp độc lập */
  devices: string[];
  maxMinutes: number;
  /** Chuỗi con (không phân biệt hoa thường). Phần tử khớp sẽ không bao giờ bị bấm. */
  blacklist: string[];
  /** Chờ sau mỗi hành động */
  stepDelayMs: number;
  /** Chờ sau khi mở app */
  launchWaitMs: number;
  /** Số bước liên tiếp không thấy màn hình mới thì mở lại app */
  staleStepsBeforeRelaunch: number;
  /** 0 = không giới hạn */
  maxSteps: number;
  dashboardPort: number;
  seed: number;
  outDir: string;
  emulators?: EmulatorsConfig;
}

export interface Screen {
  w: number;
  h: number;
}

export interface Marker {
  x: number;
  y: number;
}

export type Action =
  | { type: 'tap'; x: number; y: number; id: string; label: string }
  | { type: 'type'; x: number; y: number; id: string; text: string }
  | { type: 'swipe'; x: number; y: number; x2: number; y2: number; id: string }
  | { type: 'back' }
  | { type: 'relaunch' }
  | { type: 'none' };

export type StopReason = 'time' | 'steps' | 'saturated' | 'interrupted' | 'device_error';

/** Một dòng trong logs/<run>/<serial>.jsonl */
export interface StepRecord {
  t: string;
  dev: string;
  step: number;
  activity: string;
  sig: string;
  action: Action;
  newScreen: boolean;
  alive: boolean;
  /** crash, anr, relaunch, left_app, stuck, permission, dialog_dismissed, dump_failed, error, start */
  event?: string;
  note?: string;
  /** Ảnh chụp (đường dẫn tương đối so với thư mục run), chỉ có ở sự kiện crash/anr */
  shot?: string;
  shotAfter?: string;
  crashLog?: string;
}

export interface Stats {
  steps: number;
  uniqueScreens: number;
  crashes: number;
  anrs: number;
  relaunches: number;
  stuck: number;
  leftApp: number;
  errors: number;
}

export interface ScreenInfo {
  sig: string;
  activity: string;
  firstSeenStep: number;
}

export interface SkippedItem {
  label: string;
  id: string;
  sig: string;
  step: number;
}

export interface DeviceSummary extends Stats {
  serial: string;
  durationSec: number;
  stopReason: StopReason;
  /** Số phần tử chưa thử ở các màn hình đã thấy nhưng explorer không tìm được đường quay lại */
  untriedElements: number;
  screens: ScreenInfo[];
  skippedByBlacklist: SkippedItem[];
}

export interface RunSummary {
  package: string;
  startedAt: string;
  finishedAt: string;
  runDir: string;
  devices: DeviceSummary[];
}

/** Mọi thứ explorer cần từ một thiết bị. AdbDevice là bản thật, FakeDevice dùng để thử. */
export interface Device {
  readonly serial: string;
  ensureReady(pkg: string): Promise<void>;
  dumpUi(): Promise<string>;
  screencap(): Promise<Buffer>;
  focusedActivity(): Promise<string>;
  /** '' nếu process không chạy. Ném lỗi nếu không hỏi được thiết bị. */
  pid(pkg: string): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>;
  back(): Promise<void>;
  inputText(text: string): Promise<void>;
  keyboardShown(): Promise<boolean>;
  forceStop(pkg: string): Promise<void>;
  launch(pkg: string): Promise<void>;
  crashLog(): Promise<string>;
  clearCrashLog(): Promise<void>;
}
