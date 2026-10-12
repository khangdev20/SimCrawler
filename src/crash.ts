/** Rút một dòng tóm tắt từ `logcat -b crash`: exception Java, tín hiệu native hoặc ANR. */
export function summarizeCrash(log: string): string {
  if (!log) return '';
  const java = /\b((?:[a-z_][\w]*\.)+[A-Z]\w*(?:Exception|Error))(:[^\r\n]*)?/.exec(log);
  if (java) return clip(java[1] + (java[2] ?? ''));
  const native = /signal \d+ \(SIG[A-Z]+\)[^\r\n]*/.exec(log);
  if (native) return clip(native[0]);
  const anr = /ANR in [^\r\n]*/.exec(log);
  if (anr) return clip(anr[0]);
  const first = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('---------'));
  return first ? clip(first) : '';
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 200 ? t.slice(0, 197) + '...' : t;
}
