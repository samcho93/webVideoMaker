// 시:분:초 타임코드 변환. 메인/렌더러/테스트에서 함께 사용한다.

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 초 → "HH:MM:SS" (가장 가까운 초로 반올림) */
export function formatHMS(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** 초 → "HH:MM:SS" 또는 소수부가 있으면 "HH:MM:SS.mmm" */
export function formatPrecise(sec) {
  const total = Math.max(0, Math.round((sec || 0) * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000);
  const base = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  return ms ? `${base}.${pad(ms, 3)}` : base;
}

/** 초 → "HH:MM:SS:FF" (미리보기 타임코드) */
export function formatFrames(sec, fps) {
  const f = Math.max(0, Math.floor((sec || 0) * fps + 1e-6));
  const s = Math.floor(f / fps);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % fps)}`;
}

/** 초 → SRT 타임스탬프 "HH:MM:SS,mmm" */
export function formatSrt(sec) {
  const total = Math.max(0, Math.round((sec || 0) * 1000));
  const s = Math.floor(total / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},${pad(total % 1000, 3)}`;
}

/** "HH:MM:SS", "MM:SS", "SS", 소수부(. 또는 ,) 허용. 해석 불가면 null */
export function parseTime(text) {
  const m = /^\s*(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?(?:[.,](\d+))?\s*$/.exec(String(text));
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number);
  if (parts.slice(1).some((p) => p >= 60)) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  if (m[4]) sec += Number(`0.${m[4]}`);
  return sec;
}
