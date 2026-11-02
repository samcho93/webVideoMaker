// 오른쪽 패널: 선택 항목의 속성. 입력 중에는 패널을 다시 만들지 않아 포커스가 유지된다.

import { findMedia, itemDuration, projectDuration, SPEED_MAX, SPEED_MIN } from '/shared/model.mjs';
import { COLOR_DEFAULTS, maskPositionAt, setMaskKeyframe } from '/shared/layout.mjs';
import { formatPrecise } from '/shared/time.mjs';
import { playhead, seekTo, setClipSpeed } from './actions.js';
import { store } from './store.js';
import {
  buttonRow, checkField, colorField, el, FONTS, heading, numberField, rangeField, selectField, textArea, timeField, toast,
} from './ui.js';

const box = () => document.getElementById('properties');
const title = (t) => { document.getElementById('propTitle').textContent = t; };

/** 값 변경 도우미. 같은 입력의 연속 변경은 실행 취소 한 번으로 묶는다 */
function setter(item, key, after) {
  return (v) => store.mutate(() => { item[key] = v; after?.(v); }, { coalesce: `${item.id}-${key}` });
}

const fontOptions = () => FONTS.map((f) => [f, f]);

function timing(item, { fades = true } = {}) {
  const parts = [
    heading('시간'),
    timeField('시작', () => item.start, setter(item, 'start')),
  ];
  if (item.duration !== undefined) {
    parts.push(timeField('길이', () => item.duration, (v) => {
      if (v <= 0) { toast('길이는 0보다 커야 합니다.', { error: true }); return; }
      setter(item, 'duration')(v);
    }));
  }
  if (fades) parts.push(...fadeFields(item, item.duration ?? itemDuration(item)));
  return parts;
}

function fadeFields(item, duration) {
  const max = Math.max(0.1, Math.min(30, duration));
  return [
    rangeField('페이드 인', () => item.fadeIn || 0, setter(item, 'fadeIn'), { min: 0, max, step: 0.05 }),
    rangeField('페이드 아웃', () => item.fadeOut || 0, setter(item, 'fadeOut'), { min: 0, max, step: 0.05 }),
  ];
}

function textStyle(item) {
  return [
    selectField('글꼴', fontOptions(), () => item.font, setter(item, 'font')),
    numberField('크기', () => item.size, setter(item, 'size'), { min: 8, max: 800 }),
    colorField('글자색', () => item.color, setter(item, 'color')),
    checkField('굵게', () => item.bold, setter(item, 'bold')),
    checkField('기울임', () => item.italic, setter(item, 'italic')),
    numberField('외곽선 두께', () => item.outlineWidth, setter(item, 'outlineWidth'), { min: 0, max: 60 }),
    colorField('외곽선 색', () => item.outlineColor, setter(item, 'outlineColor')),
    checkField('그림자', () => item.shadow, setter(item, 'shadow')),
    rangeField('배경 불투명', () => item.bgOpacity, setter(item, 'bgOpacity'), { min: 0, max: 1, step: 0.05 }),
    colorField('배경색', () => item.bgColor, setter(item, 'bgColor')),
  ];
}

function renderOverlay(item) {
  title({ text: '텍스트', icon: '아이콘', shape: '도형' }[item.kind]);
  const parts = [];
  if (item.kind === 'text') {
    parts.push(
      textArea('내용', () => item.text, setter(item, 'text')),
      ...textStyle(item),
      selectField('정렬', [['left', '왼쪽'], ['center', '가운데'], ['right', '오른쪽']], () => item.align, setter(item, 'align')),
    );
  } else if (item.kind === 'icon') {
    parts.push(
      numberField('크기', () => item.size, setter(item, 'size'), { min: 8, max: 2000 }),
      colorField('색', () => item.color, setter(item, 'color')),
      checkField('그림자', () => item.shadow, setter(item, 'shadow')),
    );
  } else {
    parts.push(
      numberField('너비', () => item.w, setter(item, 'w'), { min: 4 }),
      numberField('높이', () => item.h, setter(item, 'h'), { min: 4 }),
      colorField('채우기', () => item.fill, setter(item, 'fill')),
      rangeField('채우기 불투명', () => item.fillOpacity, setter(item, 'fillOpacity'), { min: 0, max: 1, step: 0.05 }),
      numberField('테두리 두께', () => item.strokeWidth, setter(item, 'strokeWidth'), { min: 0, max: 100 }),
      colorField('테두리 색', () => item.strokeColor, setter(item, 'strokeColor')),
    );
    if (item.shape === 'rect') parts.push(numberField('모서리', () => item.radius, setter(item, 'radius'), { min: 0, max: 500 }));
  }
  parts.push(
    heading('배치'),
    numberField('가로 위치', () => item.x, setter(item, 'x')),
    numberField('세로 위치', () => item.y, setter(item, 'y')),
    rangeField('회전', () => item.rotation, setter(item, 'rotation'), { min: -180, max: 180, step: 1 }),
    rangeField('불투명도', () => item.opacity, setter(item, 'opacity'), { min: 0, max: 1, step: 0.05 }),
    ...timing(item),
  );
  box().replaceChildren(...parts);
}

function renderMask(item) {
  title(item.effect === 'mosaic' ? '모자이크' : '블러');
  const parts = [
    selectField('효과', [['mosaic', '모자이크'], ['blur', '블러']], () => item.effect, (v) => {
      store.mutate(() => { item.effect = v; item.strength = v === 'mosaic' ? 24 : 20; });
      renderProperties();
    }),
    selectField('모양', [['rect', '사각형'], ['ellipse', '타원']], () => item.shape, setter(item, 'shape')),
    rangeField(item.effect === 'mosaic' ? '블록 크기' : '흐림 정도', () => item.strength, setter(item, 'strength'), { min: 2, max: item.effect === 'mosaic' ? 120 : 80, step: 1 }),
    heading('영역'),
    ...(item.keyframes?.length ? [] : [
      numberField('왼쪽', () => item.x, setter(item, 'x')),
      numberField('위', () => item.y, setter(item, 'y')),
    ]),
    numberField('너비', () => item.w, setter(item, 'w'), { min: 4 }),
    numberField('높이', () => item.h, setter(item, 'h'), { min: 4 }),
    ...maskKeyframeFields(item),
    ...timing(item, { fades: false }),
  ];
  box().replaceChildren(...parts);
}

function maskKeyframeFields(item) {
  const keys = item.keyframes ?? [];
  const parts = [
    heading('위치 변경'),
    el('p', { class: 'hint', text: '대상이 움직이면 그 시각으로 이동한 뒤 화면에서 영역을 끌어 옮기세요. 위치가 기록되고 내보내기에도 반영됩니다. Shift 를 누르고 끌면 기록 전체를 함께 옮깁니다.' }),
    selectField('이동 방식', [['linear', '부드럽게 따라가기'], ['hold', '그 시각에 바로 이동']], () => item.motion ?? 'linear', setter(item, 'motion')),
  ];
  const now = playhead() - item.start;
  keys.forEach((key, i) => {
    const axis = (name) => {
      const input = el('input', { type: 'number', step: 1, value: Math.round(key[name]), title: name === 'x' ? '왼쪽' : '위' });
      input.addEventListener('input', () => {
        if (input.value === '' || Number.isNaN(+input.value)) return;
        store.mutate(() => {
          key[name] = +input.value;
          if (i === 0) item[name] = +input.value;
        }, { coalesce: `${item.id}-kf-${i}-${name}` });
      });
      return input;
    };
    parts.push(el('div', { class: `kf-row${Math.abs(now - key.t) < 0.02 ? ' current' : ''}` },
      el('button', { class: 'kf-time', text: formatPrecise(item.start + key.t), title: '이 시각으로 이동', onclick: () => { seekTo(item.start + key.t); renderProperties(); } }),
      axis('x'),
      axis('y'),
      el('button', {
        class: 'danger',
        text: '✕',
        title: '이 위치 기록 삭제',
        onclick: () => {
          store.mutate(() => {
            keys.splice(i, 1);
            if (keys.length && i === 0) { item.x = keys[0].x; item.y = keys[0].y; }
            if (keys.length === 1) { item.x = keys[0].x; item.y = keys[0].y; item.keyframes = []; }
          });
          renderProperties();
        },
      })));
  });
  parts.push(buttonRow(
    ['현재 시각에 위치 기록', () => {
      const t = playhead();
      if (t < item.start || t >= item.start + item.duration) { toast('재생 위치를 이 효과의 구간 안으로 옮기세요.', { error: true }); return; }
      const at = maskPositionAt(item, t);
      store.mutate(() => setMaskKeyframe(item, t - item.start, Math.round(at.x), Math.round(at.y)));
      renderProperties();
    }],
    ...(keys.length ? [['위치 기록 모두 지우기', () => {
      const at = maskPositionAt(item, playhead());
      store.mutate(() => { item.keyframes = []; item.x = Math.round(at.x); item.y = Math.round(at.y); });
      renderProperties();
    }]] : []),
  ));
  return parts;
}

const COLOR_KEYS = Object.keys(COLOR_DEFAULTS);

function colorFields(item) {
  return [
    heading('영상 조절'),
    rangeField('밝기', () => item.brightness ?? 0, setter(item, 'brightness'), { min: -1, max: 1, step: 0.01 }),
    rangeField('대비', () => item.contrast ?? 0, setter(item, 'contrast'), { min: -0.9, max: 1, step: 0.01 }),
    rangeField('채도', () => item.saturation ?? 0, setter(item, 'saturation'), { min: -1, max: 2, step: 0.01 }),
    rangeField('감마', () => item.gamma ?? 1, setter(item, 'gamma'), { min: 0.2, max: 3, step: 0.01 }),
    rangeField('색온도', () => item.temperature ?? 0, setter(item, 'temperature'), { min: -1, max: 1, step: 0.01 }),
    rangeField('색조', () => item.hue ?? 0, setter(item, 'hue'), { min: -180, max: 180, step: 1 }),
    rangeField('선명도', () => item.sharpness ?? 0, setter(item, 'sharpness'), { min: 0, max: 1, step: 0.01 }),
    el('p', { class: 'hint', text: '선명도는 재생을 멈춘 화면과 내보낸 영상에 적용됩니다. 재생 중 미리보기에서는 끊김을 막기 위해 생략합니다.' }),
    buttonRow(
      ['조절 초기화', () => {
        store.mutate(() => Object.assign(item, COLOR_DEFAULTS));
        renderProperties();
      }],
      ['모든 영상에 적용', () => {
        store.mutate((p) => {
          for (const track of p.tracks) {
            if (track.type !== 'video') continue;
            for (const clip of track.clips) for (const key of COLOR_KEYS) clip[key] = item[key] ?? COLOR_DEFAULTS[key];
          }
        });
        toast('이 조절 값을 모든 영상·사진 클립에 적용했습니다.');
      }, '비디오 트랙의 모든 클립에 같은 값을 적용합니다'],
    ),
  ];
}

function renderCaption(track, item) {
  title(track.role === 'narration' ? '나레이션' : '자막');
  const { style } = track;
  const set = (key) => (v) => store.mutate(() => { style[key] = v; }, { coalesce: `${track.id}-${key}` });
  box().replaceChildren(
    textArea('내용', () => item.text, setter(item, 'text')),
    timeField('시작', () => item.start, setter(item, 'start')),
    timeField('길이', () => item.duration, (v) => { if (v > 0) setter(item, 'duration')(v); }),
    heading('트랙 전체 스타일'),
    selectField('글꼴', fontOptions(), () => style.font, set('font')),
    numberField('크기', () => style.size, set('size'), { min: 8, max: 400 }),
    colorField('글자색', () => style.color, set('color')),
    checkField('굵게', () => style.bold, set('bold')),
    numberField('외곽선 두께', () => style.outlineWidth, set('outlineWidth'), { min: 0, max: 40 }),
    colorField('외곽선 색', () => style.outlineColor, set('outlineColor')),
    checkField('그림자', () => style.shadow, set('shadow')),
    rangeField('배경 불투명', () => style.bgOpacity, set('bgOpacity'), { min: 0, max: 1, step: 0.05 }),
    colorField('배경색', () => style.bgColor, set('bgColor')),
    selectField('위치', [['bottom', '아래'], ['middle', '가운데'], ['top', '위']], () => style.position, set('position')),
    numberField('가장자리 여백', () => style.margin, set('margin'), { min: 0, max: 800 }),
  );
}

function renderClip(track, item, media) {
  const isImage = media.type === 'image';
  title(media.name);
  const parts = [
    el('p', { class: 'hint', text: `원본 ${media.width ? `${media.width}×${media.height}` : '오디오'}${media.duration ? ` · ${formatPrecise(media.duration)}` : ''}` }),
    ...(media.type !== 'audio' ? colorFields(item) : []),
    heading('시간'),
    timeField('시작', () => item.start, setter(item, 'start')),
  ];
  if (isImage) {
    parts.push(timeField('표시 길이', () => item.out, (v) => { if (v > 0) setter(item, 'out')(v); }));
  } else {
    parts.push(
      timeField('원본 시작', () => item.in, (v) => {
        if (v < item.out && v >= 0) setter(item, 'in')(v);
      }),
      timeField('원본 끝', () => item.out, (v) => {
        if (v > item.in && v <= media.duration + 0.01) setter(item, 'out')(v);
      }),
      el('p', { class: 'hint', text: `타임라인 길이 ${formatPrecise(itemDuration(item))}` }),
      numberField('재생 속도', () => item.speed, (v) => {
        if (v >= SPEED_MIN && v <= SPEED_MAX) setClipSpeed(item, track, v);
      }, { min: SPEED_MIN, max: SPEED_MAX, step: 0.25 }),
    );
  }
  parts.push(...fadeFields(item, itemDuration(item)));
  if (media.hasAudio) {
    parts.push(
      heading('소리'),
      rangeField('볼륨', () => item.volume, setter(item, 'volume'), { min: 0, max: 2, step: 0.01 }),
      checkField('음소거', () => item.muted, setter(item, 'muted')),
    );
  }
  if (media.type !== 'audio') {
    const crop = item.crop;
    const cropField = (label, key) => rangeField(label, () => crop[key], (v) => {
      store.mutate(() => { crop[key] = Math.min(v, 0.95 - (key === 'l' ? crop.r : key === 'r' ? crop.l : key === 't' ? crop.b : crop.t)); }, { coalesce: `${item.id}-crop-${key}` });
    }, { min: 0, max: 0.9, step: 0.01 });
    parts.push(
      heading('화면 맞춤 (해상도·방향)'),
      selectField('맞춤', [['contain', '전체 맞춤 (여백)'], ['cover', '꽉 채우기 (잘림)'], ['stretch', '늘리기']], () => item.fit, setter(item, 'fit')),
      checkField('블러 배경', () => item.blurBackground, setter(item, 'blurBackground')),
      buttonRow(
        ['↺ 90°', () => rotate(item, -90), '왼쪽으로 90도'],
        ['↻ 90°', () => rotate(item, 90), '오른쪽으로 90도'],
        ['좌우 반전', () => flip(item, 'flipH')],
        ['상하 반전', () => flip(item, 'flipV')],
      ),
      rangeField('회전', () => item.rotation, setter(item, 'rotation'), { min: 0, max: 359, step: 1 }),
      rangeField('크기', () => item.scale, setter(item, 'scale'), { min: 0.05, max: 4, step: 0.01 }),
      numberField('가로 이동', () => item.posX, setter(item, 'posX')),
      numberField('세로 이동', () => item.posY, setter(item, 'posY')),
      rangeField('불투명도', () => item.opacity, setter(item, 'opacity'), { min: 0, max: 1, step: 0.01 }),
      buttonRow(['배치 초기화', () => {
        store.mutate(() => Object.assign(item, { fit: 'contain', scale: 1, posX: 0, posY: 0, rotation: 0, flipH: false, flipV: false, crop: { l: 0, t: 0, r: 0, b: 0 }, blurBackground: false }));
        renderProperties();
      }]),
      heading('자르기 (크롭)'),
      cropField('왼쪽', 'l'),
      cropField('오른쪽', 'r'),
      cropField('위', 't'),
      cropField('아래', 'b'),
    );
  }
  box().replaceChildren(...parts);
}

function rotate(item, deg) {
  store.mutate(() => { item.rotation = ((item.rotation + deg) % 360 + 360) % 360; });
  renderProperties();
}

function flip(item, key) {
  store.mutate(() => { item[key] = !item[key]; });
}

const RESOLUTIONS = [
  ['1920x1080', '1920×1080 (FHD 가로)'],
  ['1280x720', '1280×720 (HD 가로)'],
  ['3840x2160', '3840×2160 (4K 가로)'],
  ['1080x1920', '1080×1920 (쇼츠·세로)'],
  ['1080x1080', '1080×1080 (정사각형)'],
  ['custom', '사용자 지정'],
];

const evenDim = (v) => Math.max(16, Math.round(v / 2) * 2);

function renderProject() {
  title('프로젝트 설정');
  const { project } = store;
  const s = project.settings;
  const current = `${s.width}x${s.height}`;
  const preset = RESOLUTIONS.some(([v]) => v === current) ? current : 'custom';
  const setSize = (w, h) => {
    store.mutate(() => { s.width = evenDim(w); s.height = evenDim(h); });
    renderProperties();
  };
  const firstVideo = project.media.find((m) => m.type === 'video' || m.type === 'image');
  const parts = [
    selectField('해상도', RESOLUTIONS, () => preset, (v) => {
      if (v === 'custom') return;
      const [w, h] = v.split('x').map(Number);
      setSize(w, h);
    }),
    numberField('너비', () => s.width, (v) => { if (v >= 16) store.mutate(() => { s.width = evenDim(v); }, { coalesce: 'size-w' }); }, { min: 16, step: 2 }),
    numberField('높이', () => s.height, (v) => { if (v >= 16) store.mutate(() => { s.height = evenDim(v); }, { coalesce: 'size-h' }); }, { min: 16, step: 2 }),
    selectField('프레임 수', [['24', '24 fps'], ['25', '25 fps'], ['30', '30 fps'], ['50', '50 fps'], ['60', '60 fps']], () => s.fps, (v) => {
      store.mutate(() => { s.fps = +v; });
    }),
    colorField('배경색', () => s.background, (v) => store.mutate(() => { s.background = v; }, { coalesce: 'bg' })),
  ];
  if (firstVideo) {
    parts.push(buttonRow([`첫 영상에 맞추기 (${firstVideo.width}×${firstVideo.height})`, () => setSize(firstVideo.width, firstVideo.height)]));
  }
  parts.push(
    el('p', { class: 'hint', text: `총 길이 ${formatPrecise(projectDuration(project))} · 미디어 ${project.media.length}개` }),
    heading('단축키'),
    el('p', {
      class: 'hint',
      style: 'white-space:pre-line',
      text: 'Space 재생/일시정지\nS 자르기 · Delete 삭제\nI / O 구간 시작 / 끝\n← → 한 프레임 (Shift: 1초)\nHome / End 처음 / 끝\nPageUp / PageDown 이전 / 다음 구간\n\\ 전체 보기 · Shift+\\ 선택 보기\nCtrl+C / V 복사 / 붙여넣기\nCtrl+Z / Y 실행 취소 / 다시\n휠 타임라인 확대·축소\nShift+휠 좌우 · Alt+휠 위아래 이동\n빈 곳·가운데 버튼 끌기 화면 이동',
    }),
  );
  box().replaceChildren(...parts);
}

export function renderProperties() {
  const sel = store.selected();
  if (!sel) { renderProject(); return; }
  const { track, item } = sel;
  if (track.type === 'overlay') renderOverlay(item);
  else if (track.type === 'effect') renderMask(item);
  else if (track.type === 'caption') renderCaption(track, item);
  else {
    const media = findMedia(store.project, item.mediaId);
    if (media) renderClip(track, item, media);
  }
}

export function bindProperties() {
  store.on('selection', renderProperties);
  // 패널 안에서 입력 중이 아닐 때만 갱신 (실행 취소, 타임라인 트림 반영)
  store.on('project', () => {
    if (!box().contains(document.activeElement) || document.activeElement === document.body) renderProperties();
  });
  renderProperties();
}
