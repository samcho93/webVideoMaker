// 타임스탬프가 있는 나레이션 파일(시:분:초)과 SRT의 파서/직렬화.
//
// 나레이션 파일 형식 (한 줄에 한 항목, # 으로 시작하면 주석):
//   00:00:05 안녕하세요.
//   00:00:12 - 00:00:18 끝 시각을 지정한 항목입니다.
//   00:00:20 <audio:voice01.mp3> 음성 파일을 직접 지정한 항목입니다.
// 타임스탬프가 없는 줄은 이전 항목의 다음 줄로 이어 붙인다.

import { formatHMS, formatSrt, parseTime } from './time.mjs';

const TS = String.raw`\d{1,3}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?`;
const LINE_RE = new RegExp(
  String.raw`^\s*[\[(]?(${TS})[\])]?\s*(?:(?:-->|~|–|-)\s*[\[(]?(${TS})[\])]?)?\s*[:|]?\s*(.*)$`
);
const AUDIO_RE = /<audio:([^>]+)>\s*/i;
const MIN_DURATION = 1.5;
const SECONDS_PER_CHAR = 0.2;

/** 끝 시각이 없는 항목의 표시 길이 추정 */
export function estimateDuration(text) {
  const chars = text.replace(/\s+/g, '').length;
  return Math.max(MIN_DURATION, chars * SECONDS_PER_CHAR);
}

/** @returns {{items: {start:number, duration:number, text:string, voice:string|null}[], errors: {line:number, text:string}[]}} */
export function parseNarration(source) {
  const lines = String(source).replace(/^﻿/, '').split(/\r?\n/);
  const raw = [];
  const errors = [];
  lines.forEach((line, idx) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const m = LINE_RE.exec(line);
    const start = m ? parseTime(m[1]) : null;
    if (start === null) {
      if (raw.length) raw[raw.length - 1].text += `\n${line.trim()}`;
      else errors.push({ line: idx + 1, text: line.trim() });
      return;
    }
    let text = m[3];
    let voice = null;
    const am = AUDIO_RE.exec(text);
    if (am) {
      voice = am[1].trim();
      text = text.replace(AUDIO_RE, '');
    }
    raw.push({ start, end: m[2] ? parseTime(m[2]) : null, text: text.trim(), voice });
  });
  raw.sort((a, b) => a.start - b.start);
  const items = raw.map((it, i) => {
    const next = raw[i + 1];
    let end = it.end;
    if (end === null || end <= it.start) {
      end = it.start + estimateDuration(it.text);
      if (next && next.start > it.start) end = Math.min(end, next.start);
    }
    return { start: it.start, duration: end - it.start, text: it.text, voice: it.voice };
  });
  return { items, errors };
}

/** 항목 → 나레이션 파일 문자열. 타임스탬프는 시:분:초 */
export function serializeNarration(items, title = 'WebVideoMaker') {
  const out = [`# ${title} 나레이션 (형식: 시:분:초 - 시:분:초 내용)`];
  const sorted = [...items].sort((a, b) => a.start - b.start);
  for (const it of sorted) {
    const start = formatHMS(it.start);
    let endSec = Math.round(it.start + it.duration);
    if (endSec <= Math.round(it.start)) endSec = Math.round(it.start) + 1;
    const voice = it.voice ? `<audio:${it.voice}> ` : '';
    const lines = String(it.text).split(/\r?\n/);
    out.push(`${start} - ${formatHMS(endSec)} ${voice}${lines[0]}`);
    out.push(...lines.slice(1));
  }
  return `${out.join('\r\n')}\r\n`;
}

export function parseSrt(source) {
  const blocks = String(source).replace(/^﻿/, '').replace(/^WEBVTT[^\n]*\n/, '').split(/\r?\n\s*\r?\n/);
  const items = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a.trim().split(/\s+/)[0]);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (start === null || end === null || end <= start) continue;
    const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    items.push({ start, duration: end - start, text, voice: null });
  }
  return items.sort((a, b) => a.start - b.start);
}

export function serializeSrt(items) {
  return [...items]
    .sort((a, b) => a.start - b.start)
    .map((it, i) => `${i + 1}\r\n${formatSrt(it.start)} --> ${formatSrt(it.start + it.duration)}\r\n${it.text}\r\n`)
    .join('\r\n');
}
