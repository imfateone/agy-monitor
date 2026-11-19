import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'zh-CN',
  enableFooterBar: true,
  enableTurnPills: true,
  showQuotaInSidebar: true,
});

const CHOICES = {
  language: ['zh-CN', 'en'],
  enableFooterBar: [true, false],
  enableTurnPills: [true, false],
  showQuotaInSidebar: [true, false],
};

export function normalizeSettings(raw = {}) {
  const next = { ...DEFAULT_SETTINGS };
  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (allowed.includes(raw?.[key])) next[key] = raw[key];
  }
  return next;
}

export function createSettingsStore(filePath = join(homedir(), '.gemini', 'config', 'agy-monitor', 'settings.json')) {
  let cached = { ...DEFAULT_SETTINGS };
  let lastStamp = '';

  function read() {
    try {
      const st = statSync(filePath);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== lastStamp) {
        cached = normalizeSettings(JSON.parse(readFileSync(filePath, 'utf8')));
        lastStamp = stamp;
      }
    } catch {
      cached = { ...DEFAULT_SETTINGS };
      lastStamp = '';
    }
    return { ...cached };
  }

  function update(patch = {}) {
    const next = normalizeSettings({ ...read(), ...patch });
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
    lastStamp = '';
    return read();
  }

  return { read, update };
}
