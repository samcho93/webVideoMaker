// 프로젝트 데이터 모델. 프로젝트 파일(.wvm)은 이 구조의 JSON 이다.

export const PROJECT_VERSION = 1;
export const MIN_ITEM_DURATION = 0.05;
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 16;

let counter = 0;
export function newId(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const DEFAULT_CAPTION_STYLE = {
  font: 'Malgun Gothic',
  size: 54,
  color: '#ffffff',
  bold: true,
  italic: false,
  outlineColor: '#000000',
  outlineWidth: 4,
  shadow: true,
  bgColor: '#000000',
  bgOpacity: 0,
  position: 'bottom',
  margin: 70,
};

export function createTrack(type, name, extra = {}) {
  return { id: newId('trk'), type, name, clips: [], muted: false, hidden: false, locked: false, ...extra };
}

export function createProject(name = '새 프로젝트') {
  return {
    version: PROJECT_VERSION,
    name,
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    media: [],
    // 배열 앞쪽이 타임라인의 위쪽, 레이어 순서도 위쪽이 앞이다.
    tracks: [
      createTrack('caption', '자막', { role: 'subtitle', style: { ...DEFAULT_CAPTION_STYLE } }),
      createTrack('caption', '나레이션', { role: 'narration', style: { ...DEFAULT_CAPTION_STYLE, position: 'top', size: 46 } }),
      createTrack('overlay', '텍스트·아이콘'),
      createTrack('effect', '모자이크·블러'),
      createTrack('video', 'V2'),
      createTrack('video', 'V1'),
      createTrack('audio', '음악'),
      createTrack('audio', '나레이션 음성', { role: 'voice' }),
    ],
  };
}

export const isMediaClip = (item) => item.mediaId !== undefined;

export function itemDuration(item) {
  if (isMediaClip(item)) return (item.out - item.in) / (item.speed || 1);
  return item.duration;
}

export const itemEnd = (item) => item.start + itemDuration(item);

export function projectDuration(project) {
  let end = 0;
  for (const track of project.tracks) for (const c of track.clips) end = Math.max(end, itemEnd(c));
  return end;
}

export const findMedia = (project, id) => project.media.find((m) => m.id === id);

export function trackEnd(track) {
  return track.clips.reduce((end, c) => Math.max(end, itemEnd(c)), 0);
}

export function findItem(project, itemId) {
  for (const track of project.tracks) {
    const item = track.clips.find((c) => c.id === itemId);
    if (item) return { track, item };
  }
  return null;
}

const IMAGE_DEFAULT_DURATION = 5;

export function createMediaClip(media, start = 0) {
  const base = {
    id: newId('clp'),
    mediaId: media.id,
    start,
    in: 0,
    out: media.type === 'image' ? IMAGE_DEFAULT_DURATION : media.duration,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    audioFadeOut: 0,
  };
  if (media.type === 'audio') return base;
  return {
    ...base,
    fit: 'contain',
    blurBackground: false,
    scale: 1,
    posX: 0,
    posY: 0,
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    opacity: 1,
    brightness: 0,
    contrast: 0,
    saturation: 0,
  };
}

const overlayBase = (start, x, y) => ({
  id: newId('ovl'),
  start,
  duration: 5,
  x,
  y,
  rotation: 0,
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
});

export function createTextOverlay(start, W, H, patch = {}) {
  return {
    ...overlayBase(start, W / 2, H / 2),
    kind: 'text',
    text: '텍스트를 입력하세요',
    font: 'Malgun Gothic',
    size: 96,
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    lineHeight: 1.25,
    outlineColor: '#000000',
    outlineWidth: 0,
    shadow: true,
    bgColor: '#000000',
    bgOpacity: 0,
    ...patch,
  };
}

export function createIconOverlay(start, W, H, icon, patch = {}) {
  return { ...overlayBase(start, W / 2, H / 2), kind: 'icon', icon, size: 200, color: '#ffd24a', shadow: true, ...patch };
}

export function createShapeOverlay(start, W, H, shape, patch = {}) {
  return {
    ...overlayBase(start, W / 2, H / 2),
    kind: 'shape',
    shape,
    w: 500,
    h: 300,
    fill: '#2f7bff',
    fillOpacity: 0.85,
    strokeColor: '#ffffff',
    strokeWidth: 0,
    radius: 24,
    ...patch,
  };
}

export function createCaption(start, duration, text, voice = null) {
  return { id: newId('cap'), start, duration, text, voice, voiceClipId: null };
}

export function createMask(start, W, H, effect = 'mosaic', shape = 'rect') {
  const w = Math.round(W * 0.2);
  const h = Math.round(H * 0.25);
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  return {
    id: newId('msk'),
    effect,
    shape,
    start,
    duration: 5,
    x,
    y,
    w,
    h,
    strength: effect === 'mosaic' ? 24 : 20,
    animate: false,
    x2: x,
    y2: y,
  };
}

/** 저장본을 불러올 때 누락 필드를 채운다 */
export function normalizeProject(raw) {
  const base = createProject(raw.name);
  const project = { ...base, ...raw, settings: { ...base.settings, ...raw.settings } };
  project.media = raw.media || [];
  project.tracks = (raw.tracks || base.tracks).map((t) => ({ muted: false, hidden: false, locked: false, clips: [], ...t }));
  return project;
}
