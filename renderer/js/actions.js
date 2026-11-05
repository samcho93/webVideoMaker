// 편집 동작 모음: 미디어 가져오기, 자르기, 속도, 나레이션, 저장/열기 등.

import {
  createCaption, createMediaClip, createProject, findMedia, isMediaClip, itemDuration, itemEnd,
  MIN_ITEM_DURATION, newId, normalizeProject, projectDuration, SPEED_MAX, SPEED_MIN, trackEnd,
} from '/shared/model.mjs';
import { splitMaskKeyframes } from '/shared/layout.mjs';
import { parseNarration, parseSrt, serializeNarration, serializeSrt } from '/shared/narration.mjs';
import { mpvAvailable, whenMpvReady } from './mpvPlayer.js';
import { mediaUrl, store } from './store.js';
import { toast } from './ui.js';

const EPS = 1e-4;
const PLAY_TEST_TIMEOUT_MS = 8000;
const MAX_FAILURE_LINES = 4;
let preview = null;
export const setPreview = (p) => { preview = p; };
export const playhead = () => preview.time;
export const seekTo = (t) => preview.seek(t);

// ── 미디어 ──

// 브라우저가 해독할 수 있는 코덱. 그 밖의 형식은 시험 없이 바로 libmpv 로 재생한다
const BROWSER_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
let mpvEnabled = true;
/** 변환 방식 시험용 */
export const setMpvEnabled = (value) => { mpvEnabled = value; };

const peaksRequested = new Set();
const proxyStarted = new Set();
// 재생 시험은 한 번에 하나씩 한다
let playTestChain = Promise.resolve();

function deriveMedia(media) {
  const info = { ...media };
  peaksRequested.delete(media.id);
  proxyStarted.delete(media.id);
  // 대표 썸네일을 먼저 보여 주고, 타임라인용 썸네일 묶음은 뒤에서 만든다
  window.api.poster(info).then((res) => {
    const patch = { exportPath: res.exportPath };
    if (res.poster && !store.rt(media.id).sprite) Object.assign(patch, { sprite: res.poster, spriteCount: 1 });
    store.setRuntime(media.id, patch);
  }).catch((err) => console.warn('대표 썸네일 생성 실패', media.name, err))
    .then(() => window.api.derive(info))
    .then((res) => {
      const patch = { exportPath: res.exportPath };
      if (res.sprite) Object.assign(patch, { sprite: res.sprite, spriteCount: res.spriteCount });
      store.setRuntime(media.id, patch);
    })
    .catch((err) => console.warn('썸네일 생성 실패', media.name, err));
  if (media.needsProxy) preparePreview(media, info);
}

/** 타임라인에 올라간 미디어의 파형을 필요할 때 만든다 */
export function ensurePeaks(media) {
  if (!media.hasAudio || store.rt(media.id).peaks || peaksRequested.has(media.id)) return;
  peaksRequested.add(media.id);
  window.api.peaks({ ...media }).then((peaks) => store.setRuntime(media.id, { peaks }))
    .catch((err) => console.warn('파형 생성 실패', media.name, err));
}

/** 실제로 열어서 영상과 소리가 모두 해독되는지 확인한다 */
function testPlayback(path, media) {
  const attempt = () => new Promise((resolve) => {
    const node = document.createElement(media.type === 'audio' ? 'audio' : 'video');
    let timer = null;
    let finished = false;
    const finish = (ok) => {
      finished = true;
      clearTimeout(timer);
      node.onerror = null;
      node.onloadeddata = null;
      node.onseeked = null;
      node.pause();
      node.removeAttribute('src');
      node.load();
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), PLAY_TEST_TIMEOUT_MS);
    node.crossOrigin = 'anonymous';
    node.muted = true;
    node.onerror = () => finish(false);
    node.onloadeddata = () => {
      if (media.type === 'video' && !node.videoWidth) { finish(false); return; }
      node.onseeked = () => {
        node.onseeked = null;
        node.play().catch(() => {});
        const check = () => {
          if (finished) return;
          const video = media.type !== 'video' || node.webkitDecodedFrameCount > 0;
          const audio = !media.hasAudio || node.webkitAudioDecodedByteCount > 0;
          if (video && audio) finish(true);
          else setTimeout(check, 50);
        };
        check();
      };
      node.currentTime = Math.min(media.duration * 0.5, Math.max(0, media.duration - 0.5));
    };
    node.src = mediaUrl(path);
  });
  const result = playTestChain.then(attempt);
  playTestChain = result.catch(() => {});
  return result;
}

async function buildProxy(media, info, { transcode = false } = {}) {
  store.setRuntime(media.id, { proxyProgress: 0 });
  try {
    let proxy = await window.api.proxy(media.id, info, { transcode });
    // 옮겨 담은 파일이 재생되지 않으면 다시 압축한다
    if (info.canRemux && !transcode && !await testPlayback(proxy, info)) {
      store.setRuntime(media.id, { proxyProgress: 0 });
      proxy = await window.api.proxy(media.id, info, { transcode: true });
    }
    store.setRuntime(media.id, { proxy, proxyProgress: null });
  } catch (err) {
    store.setRuntime(media.id, { proxyProgress: null, proxyFailed: true });
    toast(`미리보기 변환 실패: ${media.name}\n${err.message}`, { error: true });
  }
}

async function useMpv(media) {
  if (!mpvEnabled || store.rt(media.id).mpvFailed || !await whenMpvReady()) return false;
  store.setRuntime(media.id, { engine: 'mpv', forceProxy: false, playable: false });
  return true;
}

/**
 * 재생 준비. 브라우저가 해독할 수 있는 형식이면 시험해서 그대로 쓰고,
 * 아니면 변환 없이 libmpv 로 바로 재생한다. libmpv 를 쓸 수 없을 때만 미리보기 파일을 만든다.
 */
async function preparePreview(media, info) {
  if (media.type !== 'image') {
    const codecs = [media.videoCodec, media.audioCodec].filter(Boolean);
    if (codecs.every((c) => BROWSER_CODECS.has(c))) {
      store.setRuntime(media.id, { checking: true });
      const playable = await testPlayback(media.path, info);
      store.setRuntime(media.id, { checking: false, playable });
      if (playable) return;
    }
    if (await useMpv(media)) return;
  }
  proxyStarted.add(media.id);
  await buildProxy(media, info);
}

/** 미리보기 재생이 실패했을 때 호출한다. 프록시를 만들거나, 프록시가 문제면 다시 압축한다 */
export function reportPlaybackError(media, path) {
  const rt = store.rt(media.id);
  if (rt.proxyFailed || rt.missing) return;
  if (rt.engine === 'mpv') {
    // libmpv 도 실패하면 변환 방식으로 넘어간다
    store.setRuntime(media.id, { engine: null, mpvFailed: true, forceProxy: true });
    if (!proxyStarted.has(media.id)) {
      proxyStarted.add(media.id);
      buildProxy(media, { ...media });
    }
    return;
  }
  if (mpvEnabled && mpvAvailable() && !rt.mpvFailed && !rt.proxy) {
    store.setRuntime(media.id, { engine: 'mpv', forceProxy: false, playable: false });
    return;
  }
  const proxyBroke = rt.proxy && rt.proxy === path;
  if (proxyBroke && !rt.retranscoded) {
    store.setRuntime(media.id, { proxy: null, forceProxy: true, retranscoded: true });
    buildProxy(media, { ...media }, { transcode: true });
    return;
  }
  if (proxyBroke || proxyStarted.has(media.id)) return;
  proxyStarted.add(media.id);
  store.setRuntime(media.id, { forceProxy: true, playable: false });
  buildProxy(media, { ...media });
}

/** 재생 위치를 앞뒤 구간 경계(클립·효과의 시작과 끝, 지정 구간)로 옮긴다 */
export function jumpSection(direction) {
  const { project, range } = store;
  const edges = new Set([0, projectDuration(project)]);
  for (const track of project.tracks) {
    if (track.type === 'caption') continue;
    for (const item of track.clips) {
      edges.add(item.start);
      edges.add(itemEnd(item));
    }
  }
  if (range.in !== null) edges.add(range.in);
  if (range.out !== null) edges.add(range.out);
  const sorted = [...edges].sort((a, b) => a - b);
  const now = preview.time;
  const target = direction > 0 ? sorted.find((t) => t > now + EPS) : sorted.reverse().find((t) => t < now - EPS);
  if (target === undefined) return;
  preview.pause();
  preview.seek(target);
  store.emit('reveal-time', target);
}

/** 파일을 미디어함에 추가하고 추가된(또는 기존) 미디어를 돌려준다. 분석이 끝나는 대로 고른 순서에 맞춰 나타난다 */
export async function importPaths(paths) {
  const files = await window.api.expand(paths);
  if (!files.length) {
    if (paths.length) toast('폴더 안에 가져올 미디어 파일이 없습니다.', { error: true });
    return [];
  }
  const results = new Array(files.length);
  const added = [];
  const failed = [];
  const coalesce = `import-${newId('batch')}`;
  let next = 0;
  let done = 0;
  const flush = () => {
    const fresh = [];
    while (next < files.length && results[next]) {
      const res = results[next];
      next += 1;
      if (!res.ok) {
        failed.push(res);
        continue;
      }
      const existing = [...store.project.media, ...fresh].find((m) => m.path === res.info.path);
      const media = existing || { ...res.info, id: newId('med') };
      added.push(media);
      if (!existing) fresh.push(media);
    }
    if (fresh.length) {
      store.mutate((p) => p.media.push(...fresh), { coalesce });
      fresh.forEach(deriveMedia);
    }
  };
  const setImporting = (value) => {
    store.importing = value;
    store.emit('importing');
  };
  setImporting({ done, total: files.length });
  await Promise.all(files.map(async (file, i) => {
    try {
      [results[i]] = await window.api.probe([file]);
    } catch (err) {
      results[i] = { ok: false, path: file, error: err.message };
    }
    done += 1;
    setImporting({ done, total: files.length });
    flush();
  }));
  setImporting(null);
  if (failed.length) {
    const lines = failed.slice(0, MAX_FAILURE_LINES).map((res) => `${res.path.split(/[\\/]/).pop()}: ${res.error}`);
    if (failed.length > MAX_FAILURE_LINES) lines.push(`외 ${failed.length - MAX_FAILURE_LINES}개`);
    toast(`가져오기 실패\n${lines.join('\n')}`, { error: true });
  }
  return added;
}

/** 탐색기에서 타임라인으로 끌어온 파일을 가져와서 놓은 위치부터 차례로 배치한다 */
export async function importAndPlace(paths, trackFor, start) {
  const medias = await importPaths(paths);
  const cursor = { video: start, audio: start };
  for (const media of medias) {
    const kind = media.type === 'audio' ? 'audio' : 'video';
    const trackId = trackFor(kind);
    if (!trackId) continue;
    const clip = placeOnTrack(media.id, trackId, cursor[kind]);
    if (clip) cursor[kind] = itemEnd(clip);
  }
  return medias;
}

export async function importDialog() {
  const paths = await window.api.pickMedia();
  if (paths.length) await importPaths(paths);
}

function targetTrack(media, project) {
  const type = media.type === 'audio' ? 'audio' : 'video';
  const candidates = project.tracks.filter((t) => t.type === type && !t.locked && t.role !== 'voice');
  // 비디오는 아래쪽 V1 부터 채운다
  return type === 'video' ? candidates[candidates.length - 1] : candidates[0];
}

/** 클립을 트랙 끝에 이어 붙인다 */
export function appendToTimeline(mediaId) {
  const media = findMedia(store.project, mediaId);
  if (!media) return;
  const track = targetTrack(media, store.project);
  if (!track) { toast('사용할 수 있는 트랙이 없습니다.', { error: true }); return; }
  const clip = createMediaClip(media, trackEnd(track));
  store.mutate(() => track.clips.push(clip));
  store.select(clip.id);
  store.emit('fit-timeline');
}

export function placeOnTrack(mediaId, trackId, start) {
  const media = findMedia(store.project, mediaId);
  const track = store.project.tracks.find((t) => t.id === trackId);
  if (!media || !track || track.locked) return null;
  const clip = createMediaClip(media, Math.max(0, start));
  store.mutate(() => track.clips.push(clip));
  store.select(clip.id);
  return clip;
}

export function removeMedia(mediaId) {
  store.mutate((p) => {
    p.media = p.media.filter((m) => m.id !== mediaId);
    for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== mediaId);
  });
  if (store.selection && !store.selected()) store.select(null);
}

export function addItem(trackType, item, role = null) {
  const track = store.project.tracks.find((t) => t.type === trackType && (!role || t.role === role));
  if (!track) return;
  store.mutate(() => track.clips.push(item));
  store.select(item.id);
}

// ── 자르기/삭제 ──

/** 항목을 시각 t 에서 둘로 나눈다. 뒷부분을 돌려준다 */
function splitItem(track, item, t) {
  if (t <= item.start + EPS || t >= itemEnd(item) - EPS) return null;
  const tail = JSON.parse(JSON.stringify(item));
  tail.id = newId(item.id.split('_')[0]);
  tail.start = t;
  if (isMediaClip(item)) {
    const cut = item.in + (t - item.start) * item.speed;
    item.out = cut;
    tail.in = cut;
    item.fadeOut = 0;
    item.audioFadeOut = 0;
    tail.fadeIn = 0;
  } else {
    item.duration = t - item.start;
    tail.duration -= item.duration;
    if (tail.voiceClipId) tail.voiceClipId = null;
    if ('fadeOut' in item) { item.fadeOut = 0; tail.fadeIn = 0; }
    // 위치 기록은 나눈 지점의 위치에서 이어지게 한다
    splitMaskKeyframes(item, tail, item.duration);
  }
  track.clips.push(tail);
  return tail;
}

/** 선택 항목을, 선택이 없거나 재생 위치에 걸치지 않으면 재생 위치의 모든 항목을 자른다 */
export function splitAtPlayhead() {
  const t = playhead();
  const sel = store.selected();
  const useSelected = sel && t > sel.item.start + EPS && t < itemEnd(sel.item) - EPS;
  store.mutate((p) => {
    if (useSelected) {
      splitItem(sel.track, sel.item, t);
      return;
    }
    for (const track of p.tracks) {
      if (track.locked) continue;
      for (const item of [...track.clips]) splitItem(track, item, t);
    }
  });
}

function removeLinkedVoice(project, item) {
  if (!item?.voiceClipId) return;
  for (const t of project.tracks) t.clips = t.clips.filter((c) => c.id !== item.voiceClipId);
}

export function deleteSelected({ ripple = false } = {}) {
  const sel = store.selected();
  if (!sel || sel.track.locked) return;
  const { track, item } = sel;
  const start = item.start;
  const dur = itemDuration(item);
  store.mutate((p) => {
    track.clips = track.clips.filter((c) => c !== item);
    removeLinkedVoice(p, item);
    if (ripple) for (const c of track.clips) if (c.start >= start + dur - EPS) c.start -= dur;
  });
  store.select(null);
}

/** 지정 구간을 잠기지 않은 모든 트랙에서 제거하고 뒤쪽을 당긴다 */
export function cutRange() {
  const { in: a, out: b } = store.range;
  if (a === null || b === null || b <= a) { toast('먼저 구간 시작(I)과 끝(O)을 지정하세요.', { error: true }); return; }
  const len = b - a;
  store.mutate((p) => {
    for (const track of p.tracks) {
      if (track.locked) continue;
      for (const item of [...track.clips]) {
        splitItem(track, item, a);
      }
      for (const item of [...track.clips]) {
        splitItem(track, item, b);
      }
      track.clips = track.clips.filter((c) => c.start < a - EPS || c.start >= b - EPS);
      for (const c of track.clips) if (c.start >= b - EPS) c.start -= len;
    }
  });
  store.range = { in: null, out: null };
  store.emit('range');
  if (store.selection && !store.selected()) store.select(null);
  preview.seek(a);
}

/** 크로스페이드: 선택 클립을 앞 클립과 겹치게 당기고 페이드인을 준다 */
export function crossfade(seconds = 1) {
  const sel = store.selected();
  if (!sel || !isMediaClip(sel.item)) { toast('크로스페이드할 클립을 선택하세요.', { error: true }); return; }
  const { track, item } = sel;
  const prev = track.clips
    .filter((c) => c !== item && itemEnd(c) <= item.start + EPS)
    .sort((a, b) => itemEnd(b) - itemEnd(a))[0];
  if (!prev) { toast('이 클립 앞에 이어지는 클립이 없습니다.', { error: true }); return; }
  const d = Math.min(seconds, itemDuration(prev) / 2, itemDuration(item) / 2);
  const shift = item.start - (itemEnd(prev) - d);
  store.mutate(() => {
    for (const c of track.clips) if (c !== prev && c.start >= item.start - EPS && c !== item) c.start -= shift;
    item.start -= shift;
    item.fadeIn = d;
    prev.audioFadeOut = d;
  });
}

/** 선택 클립의 지정 구간(없으면 전체)에 속도를 적용한다. 뒤쪽 클립은 길이 변화만큼 이동한다 */
export function applySpeedToRange(speed) {
  const sel = store.selected();
  if (!sel || !isMediaClip(sel.item)) { toast('속도를 바꿀 비디오/오디오 클립을 선택하세요.', { error: true }); return; }
  const { track, item } = sel;
  const media = findMedia(store.project, item.mediaId);
  if (media?.type === 'image') { toast('사진 클립에는 속도를 적용할 수 없습니다.', { error: true }); return; }
  const s = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  const a = Math.max(store.range.in ?? item.start, item.start);
  const b = Math.min(store.range.out ?? itemEnd(item), itemEnd(item));
  if (b - a < MIN_ITEM_DURATION) { toast('지정한 구간이 선택 클립과 겹치지 않습니다.', { error: true }); return; }

  store.mutate(() => {
    splitItem(track, item, b);
    const mid = splitItem(track, item, a) || item;
    const oldEnd = itemEnd(mid);
    mid.speed = s;
    const delta = itemEnd(mid) - oldEnd;
    for (const c of track.clips) if (c !== mid && c.start >= oldEnd - EPS) c.start += delta;
    store.selection = mid.id;
  });
  store.range = { in: null, out: null };
  store.emit('range');
  store.emit('selection');
  toast(`${s}배속을 적용했습니다. 영상 파일 생성 시 반영됩니다.`);
}

export function setClipSpeed(item, track, speed) {
  const s = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  store.mutate(() => {
    const oldEnd = itemEnd(item);
    item.speed = s;
    const delta = itemEnd(item) - oldEnd;
    for (const c of track.clips) if (c !== item && c.start >= oldEnd - EPS) c.start += delta;
  }, { coalesce: `speed-${item.id}` });
}

export function copySelected() {
  const sel = store.selected();
  if (sel) store.clipboard = { trackId: sel.track.id, item: JSON.parse(JSON.stringify(sel.item)) };
}

export function pasteClipboard() {
  const cb = store.clipboard;
  if (!cb) return;
  const track = store.project.tracks.find((t) => t.id === cb.trackId);
  if (!track || track.locked) return;
  const item = { ...JSON.parse(JSON.stringify(cb.item)), id: newId(cb.item.id.split('_')[0]), start: playhead() };
  if (item.voiceClipId) item.voiceClipId = null;
  store.mutate(() => track.clips.push(item));
  store.select(item.id);
}

export function addTrack(type) {
  const label = type === 'video' ? 'V' : type === 'audio' ? 'A' : 'O';
  const count = store.project.tracks.filter((t) => t.type === type).length + 1;
  const track = { id: newId('trk'), type, name: `${label}${count}`, clips: [], muted: false, hidden: false, locked: false };
  store.mutate((p) => {
    // 같은 종류 트랙 맨 위에 추가한다
    const index = p.tracks.findIndex((t) => t.type === type);
    p.tracks.splice(index < 0 ? p.tracks.length : index, 0, track);
  });
}

export function removeTrack(trackId) {
  store.mutate((p) => { p.tracks = p.tracks.filter((t) => t.id !== trackId); });
  if (store.selection && !store.selected()) store.select(null);
}

export function fitAll(mode) {
  store.mutate((p) => {
    for (const t of p.tracks) {
      if (t.type !== 'video') continue;
      for (const c of t.clips) {
        Object.assign(c, { fit: mode === 'blur' ? 'contain' : mode, blurBackground: mode === 'blur', scale: 1, posX: 0, posY: 0 });
      }
    }
  });
  toast('모든 비디오 클립의 맞춤 방식을 변경했습니다.');
}

// ── 자막/나레이션 ──

const captionTrack = (role) => store.project.tracks.find((t) => t.type === 'caption' && t.role === role);

export function addCaptionAtPlayhead(role) {
  const item = createCaption(playhead(), 3, role === 'narration' ? '나레이션 내용' : '자막 내용');
  addItem('caption', item, role);
  return item;
}

function replaceOrAppend(track, items, replace) {
  store.mutate((p) => {
    if (replace) {
      for (const old of track.clips) removeLinkedVoice(p, old);
      track.clips = [];
    }
    for (const it of items) track.clips.push(createCaption(it.start, it.duration, it.text, it.voice || null));
    track.clips.sort((a, b) => a.start - b.start);
  });
}

async function askReplace(track) {
  if (!track.clips.length) return true;
  const choice = await window.api.confirm({
    message: `"${track.name}" 트랙에 이미 ${track.clips.length}개 항목이 있습니다.`,
    buttons: ['기존 항목 교체', '뒤에 추가', '취소'],
  });
  return choice === 2 ? null : choice === 0;
}

/** 나레이션 파일의 <audio:...> 를 음성 트랙에 배치한다 */
async function placeVoiceFiles(track, basePath) {
  const voiceTrack = store.project.tracks.find((t) => t.role === 'voice');
  let missing = 0;
  for (const item of track.clips) {
    if (!item.voice || item.voiceClipId) continue;
    const resolved = await window.api.resolveRelative(basePath, item.voice);
    const media = resolved ? (await importPaths([resolved]))[0] : null;
    if (!media) { missing += 1; continue; }
    const clip = createMediaClip(media, item.start);
    store.mutate(() => {
      voiceTrack.clips.push(clip);
      item.voiceClipId = clip.id;
    });
  }
  if (missing) toast(`음성 파일 ${missing}개를 찾지 못했습니다. 나레이션 파일과 같은 폴더 기준으로 찾습니다.`, { error: true });
}

export async function importNarrationFile() {
  const file = await window.api.openTextFile({ title: '나레이션 파일 불러오기', extensions: ['txt', 'nar', 'srt'] });
  if (!file) return;
  const track = captionTrack('narration');
  const isSrt = file.path.toLowerCase().endsWith('.srt');
  const parsed = isSrt ? { items: parseSrt(file.text), errors: [] } : parseNarration(file.text);
  if (!parsed.items.length) {
    toast('타임스탬프가 있는 줄을 찾지 못했습니다.\n예: 00:00:05 안녕하세요.', { error: true });
    return;
  }
  const replace = await askReplace(track);
  if (replace === null) return;
  replaceOrAppend(track, parsed.items, replace);
  await placeVoiceFiles(track, file.path);
  let msg = `나레이션 ${parsed.items.length}개를 불러왔습니다.`;
  if (parsed.errors.length) msg += `\n해석하지 못한 줄 ${parsed.errors.length}개: ${parsed.errors.slice(0, 3).map((e) => `${e.line}행`).join(', ')}`;
  toast(msg, { error: parsed.errors.length > 0 });
}

export async function exportNarrationFile() {
  const track = captionTrack('narration');
  if (!track.clips.length) { toast('내보낼 나레이션이 없습니다.', { error: true }); return; }
  const saved = await window.api.saveTextFile({
    title: '나레이션 파일 저장',
    defaultName: `${store.project.name}-나레이션.txt`,
    extensions: ['txt'],
    text: serializeNarration(track.clips, store.project.name),
  });
  if (saved) toast(`저장했습니다: ${saved}`);
}

export async function importSrt(role) {
  const file = await window.api.openTextFile({ title: '자막 파일 불러오기', extensions: ['srt', 'vtt'] });
  if (!file) return;
  const items = parseSrt(file.text);
  if (!items.length) { toast('자막을 찾지 못했습니다.', { error: true }); return; }
  const track = captionTrack(role);
  const replace = await askReplace(track);
  if (replace === null) return;
  replaceOrAppend(track, items, replace);
  toast(`자막 ${items.length}개를 불러왔습니다.`);
}

export async function exportSrt(role) {
  const track = captionTrack(role);
  if (!track.clips.length) { toast('내보낼 자막이 없습니다.', { error: true }); return; }
  const saved = await window.api.saveTextFile({
    title: '자막 파일 저장',
    defaultName: `${store.project.name}-${track.name}.srt`,
    extensions: ['srt'],
    text: serializeSrt(track.clips),
  });
  if (saved) toast(`저장했습니다: ${saved}`);
}

/** 나레이션 문장을 음성으로 합성해 음성 트랙에 넣는다. 문장이 바뀐 항목만 다시 만든다 */
export async function generateNarrationVoices({ voice, rate }) {
  const track = captionTrack('narration');
  const voiceTrack = store.project.tracks.find((t) => t.role === 'voice');
  const hasClip = (id) => voiceTrack.clips.some((c) => c.id === id);
  const targets = track.clips.filter((c) => c.text.trim() && !c.voice && (!hasClip(c.voiceClipId) || c.voiceText !== c.text || c.voiceName !== voice || c.voiceRate !== rate));
  if (!targets.length) { toast('새로 생성할 나레이션이 없습니다.'); return; }
  const progress = toast(`음성 생성 중… 0/${targets.length}`, { ms: 600000 });
  try {
    let done = 0;
    for (const item of targets) {
      const wav = await window.api.ttsGenerate({ text: item.text, voice, rate });
      const [media] = await importPaths([wav]);
      const clip = createMediaClip(media, item.start);
      store.mutate((p) => {
        removeLinkedVoice(p, item);
        voiceTrack.clips.push(clip);
        Object.assign(item, { voiceClipId: clip.id, voiceText: item.text, voiceName: voice, voiceRate: rate });
        // 음성이 더 길면 다음 항목 전까지 자막 표시 시간을 늘린다
        const next = track.clips.filter((c) => c.start > item.start).sort((a, b) => a.start - b.start)[0];
        const limit = next ? next.start - item.start : Infinity;
        item.duration = Math.max(item.duration, Math.min(media.duration, limit));
      });
      done += 1;
      progress.textContent = `음성 생성 중… ${done}/${targets.length}`;
    }
    toast(`나레이션 음성 ${done}개를 생성했습니다.`);
  } catch (err) {
    toast(`음성 생성 실패: ${err.message}`, { error: true });
  } finally {
    progress.remove();
  }
}

// ── 프로젝트 파일 ──

export async function saveProject({ saveAs = false } = {}) {
  const json = JSON.stringify(store.project, null, 1);
  const target = await window.api.saveProject({ filePath: saveAs ? null : store.filePath, json, name: store.project.name });
  if (!target) return false;
  store.filePath = target;
  store.project.name = target.split(/[\\/]/).pop().replace(/\.wvm$/i, '');
  store.setDirty(false);
  window.api.clearAutosave();
  toast('저장했습니다.');
  return true;
}

export async function confirmDiscard() {
  if (!store.dirty) return true;
  const choice = await window.api.confirm({
    message: '저장하지 않은 변경 사항이 있습니다.',
    buttons: ['저장', '저장 안 함', '취소'],
  });
  if (choice === 2) return false;
  if (choice === 0) return saveProject();
  return true;
}

export async function newProject() {
  if (!await confirmDiscard()) return;
  store.load(createProject());
  preview.pause();
  preview.seek(0);
}

/** JSON → 프로젝트 적재. 파일 위치 확인과 파생 파일 복구까지 수행한다 */
export async function loadProjectJson(json, filePath) {
  let project;
  try {
    project = normalizeProject(JSON.parse(json));
  } catch (err) {
    toast(`프로젝트 파일을 읽을 수 없습니다: ${err.message}`, { error: true });
    return;
  }
  const missing = [];
  for (const media of project.media) {
    let [res] = await window.api.probe([media.path]);
    if (!res.ok && media.relPath && filePath) {
      const alt = await window.api.resolveRelative(filePath, media.relPath);
      if (alt) [res] = await window.api.probe([alt]);
    }
    if (!res.ok) {
      const choice = await window.api.confirm({
        message: `미디어 파일을 찾을 수 없습니다:\n${media.path}`,
        buttons: ['위치 찾기', '건너뛰기'],
      });
      if (choice === 0) {
        const picked = await window.api.pickRelink(media.name);
        if (picked) [res] = await window.api.probe([picked]);
      }
    }
    if (res.ok) Object.assign(media, { ...res.info, id: media.id });
    else missing.push(media.id);
  }
  store.load(project, filePath);
  for (const id of missing) store.setRuntime(id, { missing: true });
  for (const media of project.media) if (!missing.includes(media.id)) deriveMedia(media);
  preview.pause();
  preview.seek(0);
  store.emit('fit-timeline');
  if (missing.length) toast(`찾지 못한 미디어 ${missing.length}개는 내보내기 전에 다시 연결해야 합니다.`, { error: true });
}

export async function openProject(path = null) {
  if (!await confirmDiscard()) return;
  const res = await window.api.openProject(path);
  if (res) await loadProjectJson(res.json, res.path);
}

/** 찾지 못한 미디어를 다시 연결한다 */
export async function relinkMedia(mediaId) {
  const media = findMedia(store.project, mediaId);
  const picked = await window.api.pickRelink(media.name);
  if (!picked) return;
  const [res] = await window.api.probe([picked]);
  if (!res.ok) { toast(`열 수 없는 파일입니다.\n${res.error}`, { error: true }); return; }
  store.mutate(() => Object.assign(media, { ...res.info, id: media.id }));
  store.setRuntime(media.id, { missing: false });
  deriveMedia(media);
}
