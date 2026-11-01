// 작은 DOM 도우미와 속성 입력 필드.

import { formatPrecise, parseTime } from '/shared/time.mjs';

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export function toast(message, { error = false, ms = 3500 } = {}) {
  const node = el('div', { class: `toast${error ? ' error' : ''}`, text: message });
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), error ? Math.max(ms, 8000) : ms);
  return node;
}

function field(label, control) {
  return el('div', { class: 'field' }, el('label', { text: label }), control);
}

/** 슬라이더 + 숫자 입력 */
export function rangeField(label, get, set, { min, max, step = 0.01, unit = '' }) {
  const range = el('input', { type: 'range', min, max, step, value: get() });
  const num = el('input', { type: 'number', class: 'val', min, max, step, value: round(get()), title: unit });
  range.addEventListener('input', () => { num.value = round(+range.value); set(+range.value); });
  num.addEventListener('input', () => {
    if (num.value === '' || Number.isNaN(+num.value)) return;
    range.value = num.value;
    set(+num.value);
  });
  return field(label, el('div', { class: 'row' }, range, num));
}

const round = (v) => Math.round(v * 1000) / 1000;

export function numberField(label, get, set, { min, max, step = 1 } = {}) {
  const input = el('input', { type: 'number', step, value: round(get()) });
  if (min !== undefined) input.min = min;
  if (max !== undefined) input.max = max;
  input.addEventListener('input', () => {
    if (input.value !== '' && !Number.isNaN(+input.value)) set(+input.value);
  });
  return field(label, input);
}

export function textField(label, get, set) {
  const input = el('input', { type: 'text', value: get() ?? '' });
  input.addEventListener('input', () => set(input.value));
  return field(label, input);
}

export function textArea(label, get, set) {
  const input = el('textarea', { value: get() ?? '' });
  input.addEventListener('input', () => set(input.value));
  return field(label, input);
}

export function colorField(label, get, set) {
  const input = el('input', { type: 'color', value: get() });
  input.addEventListener('input', () => set(input.value));
  return field(label, input);
}

export function checkField(label, get, set) {
  const input = el('input', { type: 'checkbox', checked: !!get() });
  input.addEventListener('change', () => set(input.checked));
  return field(label, el('div', { class: 'row' }, input));
}

export function selectField(label, options, get, set) {
  const input = el('select');
  for (const [value, text] of options) input.append(el('option', { value, text }));
  input.value = String(get());
  input.addEventListener('change', () => set(input.value));
  return field(label, input);
}

/** 시:분:초 입력. 형식이 틀리면 값을 되돌린다 */
export function timeInput(get, set) {
  const input = el('input', { type: 'text', value: formatPrecise(get()), title: '시:분:초 (예: 00:01:23)', spellcheck: false });
  input.addEventListener('change', () => {
    const v = parseTime(input.value);
    if (v === null) {
      toast('시간 형식이 올바르지 않습니다. 시:분:초 로 입력하세요.', { error: true });
    } else {
      set(v);
    }
    input.value = formatPrecise(get());
  });
  return input;
}

export function timeField(label, get, set) {
  return field(label, timeInput(get, set));
}

export function buttonRow(...buttons) {
  return el('div', { class: 'btn-row' }, ...buttons.map(([text, onclick, title]) => el('button', { text, onclick, title: title || '' })));
}

export const heading = (text) => el('h3', { text });

export const FONTS = ['Malgun Gothic', 'Dotum', 'Gulim', 'Batang', 'Gungsuh', 'Segoe UI', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Courier New', 'Comic Sans MS'];

/** 시스템에 설치된 글꼴을 목록에 더한다 (권한이 없으면 기본 목록 유지) */
export async function loadSystemFonts() {
  try {
    const fonts = await window.queryLocalFonts();
    const names = new Set(FONTS);
    for (const f of fonts) names.add(f.family);
    FONTS.splice(0, FONTS.length, ...FONTS, ...[...names].filter((n) => !FONTS.includes(n)).sort());
  } catch {
    // 기본 목록 사용
  }
}
