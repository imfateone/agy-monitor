/**
 * Low-level protobuf wire parser and AGY Monitor display formatters.
 */

export function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  return [Number(val), i];
}

export function parsePbMap(buf) {
  const fields = new Map();
  if (!buf || !buf.length) return fields;
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        if (i + 4 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        if (i + 8 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

export function parseDurationSec(buf) {
  if (!buf) return null;
  const f = parsePbMap(buf);
  if (!f.has(1) && !f.has(2)) return null;
  return (f.get(1)?.[0] || 0) + (f.get(2)?.[0] || 0) / 1e9;
}

export function parseTimestampMs(buf) {
  if (!buf) return null;
  const f = parsePbMap(buf);
  if (!f.has(1)) return null;
  return Number(f.get(1)[0]) * 1000 + Number(f.get(2)?.[0] || 0) / 1e6;
}

export const SVG_GAUGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
export const SVG_DB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>';
export const SVG_CTX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

export function fmtCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    const s = m >= 10 || Math.abs(m - Math.round(m)) < 0.05 ? String(Math.round(m)) : m.toFixed(1);
    return s.replace(/\.0$/, '') + 'M';
  }
  if (v >= 10_000) return Math.round(v / 1000) + 'K';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(v));
}

export function fmtExact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtDur(sec, isEn = false) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  if (total < 60) {
    const val = sec < 10 && sec > 0 ? sec.toFixed(1) : String(total);
    return isEn ? `${val}s` : `${val} 秒`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return isEn ? (m ? `${h}h ${m}m` : `${h}h`) : (m ? `${h} 小时 ${m} 分` : `${h} 小时`);
  return isEn ? (s ? `${m}m ${s}s` : `${m}m`) : (s ? `${m} 分 ${s} 秒` : `${m} 分`);
}

export function fmtPct(pct, decimals = 1) {
  if (!Number.isFinite(pct)) return '—';
  const clamped = Math.max(0, Math.min(100, pct));
  if (decimals === 0) return `${Math.round(clamped)}%`;
  const fixed = clamped.toFixed(decimals);
  return (fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed) + '%';
}

export function fmtTps(tps) {
  if (!Number.isFinite(tps) || tps < 0) return '—';
  return `${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serializes shared SVG constants and display formatters for browser injection
 * so injector.mjs and ui.mjs stay single-sourced with Node tests.
 */
export function getClientFormattersScript() {
  return [
    `const SVG_GAUGE = ${JSON.stringify(SVG_GAUGE)};`,
    `const SVG_DB = ${JSON.stringify(SVG_DB)};`,
    `const SVG_CTX = ${JSON.stringify(SVG_CTX)};`,
    fmtCompact.toString(),
    fmtExact.toString(),
    fmtDur.toString(),
    fmtPct.toString(),
    fmtTps.toString(),
    esc.toString(),
  ].join('\n');
}
